//! Pink noise for the player headset: electron/displays/client/noise.js.
//! 30 s of pink noise (Paul Kellet's filter), equal-power crossfade of a 1 s tail into the head
//! (seamless loop), peak-normalised to -6 dBFS (0.5), separate generator per channel. Fades:
//! 1.5 s in, 0.6 s out. Level = (volume / 100) * (maxVolume / 100), clamped 0..1. Played on the
//! output device picked in the settings (blank / missing = default output, reported).
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

pub const LOOP_SECONDS: f64 = 30.0;
pub const XFADE_SECONDS: f64 = 1.0;
pub const FADE_IN: f32 = 1.5;
pub const FADE_OUT: f32 = 0.6;

/// One channel of the loop (makeBuffer, per channel). `rand` gives uniform 0..1 (Math.random).
pub fn make_channel(rate: u32, mut rand: impl FnMut() -> f64) -> Vec<f32> {
    let len = (LOOP_SECONDS * f64::from(rate)).round() as usize;
    let xf = (XFADE_SECONDS * f64::from(rate)).round() as usize;
    // Float32Array: every stored value is f32, the arithmetic in between is f64 (JS numbers)
    let mut raw = vec![0f32; len + xf];
    let (mut b0, mut b1, mut b2, mut b3, mut b4, mut b5, mut b6) = (0f64, 0f64, 0f64, 0f64, 0f64, 0f64, 0f64);
    for r in raw.iter_mut() {
        let w = rand() * 2.0 - 1.0;
        b0 = 0.99886 * b0 + w * 0.0555179;
        b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.96900 * b2 + w * 0.1538520;
        b3 = 0.86650 * b3 + w * 0.3104856;
        b4 = 0.55000 * b4 + w * 0.5329522;
        b5 = -0.7616 * b5 - w * 0.0168980;
        *r = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) as f32;
        b6 = w * 0.115926;
    }
    for i in 0..xf {
        let t = i as f64 / xf as f64;
        raw[i] = (f64::from(raw[i]) * (t * std::f64::consts::PI / 2.0).sin() + f64::from(raw[len + i]) * (t * std::f64::consts::PI / 2.0).cos()) as f32;
    }
    let peak = raw[..len].iter().fold(0f64, |p, v| p.max(f64::from(v.abs())));
    let k = 0.5 / if peak == 0.0 { 1.0 } else { peak };
    raw[..len].iter().map(|v| (f64::from(*v) * k) as f32).collect()
}

/// level(): (volume / 100) * (maxVolume / 100), 0..1.
pub fn level(volume: f64, max_volume: f64) -> f64 {
    ((volume / 100.0) * (max_volume / 100.0)).clamp(0.0, 1.0)
}

#[derive(Debug, Clone, PartialEq)]
pub struct Status {
    pub state: String,
    pub device: String,
    pub error: String,
}

struct Shared {
    /// target gain (f32 bits) and the ramp: current gain moves toward it at `step` per sample
    target: AtomicU32,
    step: AtomicU32,
}

pub struct Noise {
    shared: Arc<Shared>,
    stream: Mutex<Option<cpal::Stream>>,
    want_on: Mutex<bool>,
    volume: Mutex<f64>,
    device: Mutex<(String, String, f64)>, // (id, label, maxVolume)
    status: Mutex<Status>,
    report: Mutex<Box<dyn Fn(Status) + Send>>,
    rate: Mutex<u32>,
}

// cpal::Stream is not Send on every platform; the Noise lives on the UI thread's owner.
unsafe impl Send for Noise {}
unsafe impl Sync for Noise {}

impl Noise {
    pub fn new() -> Self {
        Self {
            shared: Arc::new(Shared { target: AtomicU32::new(0f32.to_bits()), step: AtomicU32::new(0f32.to_bits()) }),
            stream: Mutex::new(None),
            want_on: Mutex::new(false),
            volume: Mutex::new(30.0),
            device: Mutex::new((String::new(), String::new(), 60.0)),
            status: Mutex::new(Status { state: "off".into(), device: String::new(), error: String::new() }),
            report: Mutex::new(Box::new(|_| {})),
            rate: Mutex::new(48_000),
        }
    }

    pub fn on_status(&self, f: impl Fn(Status) + Send + 'static) {
        f(self.status());
        *self.report.lock().unwrap() = Box::new(f);
    }

    pub fn status(&self) -> Status {
        self.status.lock().unwrap().clone()
    }

    fn set_status(&self, state: Option<&str>, device: Option<String>, error: Option<String>) {
        let s = {
            let mut st = self.status.lock().unwrap();
            if let Some(x) = state {
                st.state = x.into();
            }
            if let Some(d) = device {
                st.device = d;
            }
            if let Some(e) = error {
                st.error = e;
            }
            st.clone()
        };
        (self.report.lock().unwrap())(s);
    }

    pub fn level(&self) -> f64 {
        level(*self.volume.lock().unwrap(), self.device.lock().unwrap().2)
    }

    /// set({ on, volume }).
    pub fn set(&self, on: bool, volume: Option<f64>) {
        *self.want_on.lock().unwrap() = on;
        if let Some(v) = volume {
            *self.volume.lock().unwrap() = if v.is_finite() { v.clamp(0.0, 100.0) } else { 0.0 };
        }
        self.apply();
    }

    /// setDevice({ id, label, maxVolume }).
    pub fn set_device(&self, id: &str, label: &str, max_volume: f64) {
        *self.device.lock().unwrap() = (id.to_string(), label.to_string(), max_volume.clamp(0.0, 100.0));
        if self.stream.lock().unwrap().is_some() {
            *self.stream.lock().unwrap() = None; // re-open on the new device
            if *self.want_on.lock().unwrap() {
                self.apply();
            }
        }
    }

    fn ramp_to(&self, target: f32, seconds: f32) {
        let rate = *self.rate.lock().unwrap() as f32;
        self.shared.target.store(target.to_bits(), Ordering::Release);
        self.shared.step.store((1.0 / (seconds * rate)).to_bits(), Ordering::Release);
    }

    fn open(&self) -> Result<(), String> {
        let host = cpal::default_host();
        let (id, label, _) = self.device.lock().unwrap().clone();
        let mut dev = None;
        let mut err = String::new();
        if !id.is_empty() {
            dev = host.output_devices().ok().and_then(|mut it| it.find(|d| d.name().ok().as_deref() == Some(id.as_str())));
            if dev.is_none() {
                err = format!("Headset \"{}\" not found, using default output", if label.is_empty() { &id } else { &label });
            }
        }
        let used_default = dev.is_none();
        let dev = dev.or_else(|| host.default_output_device()).ok_or("No audio output device")?;
        let cfg = dev.default_output_config().map_err(|e| e.to_string())?;
        let rate = cfg.sample_rate().0;
        *self.rate.lock().unwrap() = rate;
        let channels = usize::from(cfg.channels());
        let left = make_channel(rate, fastrand::f64);
        let right = make_channel(rate, fastrand::f64);
        let shared = Arc::clone(&self.shared);
        let mut pos = 0usize;
        let mut gain = 0f32;
        let stream = dev
            .build_output_stream(
                &cfg.config(),
                move |out: &mut [f32], _| {
                    let target = f32::from_bits(shared.target.load(Ordering::Acquire));
                    let step = f32::from_bits(shared.step.load(Ordering::Acquire)) * target.max(gain).max(1e-6);
                    for frame in out.chunks_mut(channels) {
                        if gain < target {
                            gain = (gain + step).min(target);
                        } else if gain > target {
                            gain = (gain - step).max(target);
                        }
                        for (c, s) in frame.iter_mut().enumerate() {
                            *s = if c % 2 == 0 { left[pos] } else { right[pos] } * gain;
                        }
                        pos = (pos + 1) % left.len();
                    }
                },
                |_| {},
                None,
            )
            .map_err(|e| e.to_string())?;
        stream.play().map_err(|e| e.to_string())?;
        *self.stream.lock().unwrap() = Some(stream);
        let shown = if used_default { "Default output".to_string() } else if label.is_empty() { id } else { label };
        self.set_status(None, Some(shown), Some(err));
        Ok(())
    }

    fn apply(&self) {
        if *self.want_on.lock().unwrap() {
            if self.stream.lock().unwrap().is_none() {
                if let Err(e) = self.open() {
                    return self.set_status(Some("error"), None, Some(e));
                }
            }
            self.ramp_to(self.level() as f32, FADE_IN);
            self.set_status(Some("playing"), None, None);
        } else {
            // JS apply(): fade out, setStatus({ state: 'off' }) (the error text stays, like the JS)
            self.ramp_to(0.0, FADE_OUT);
            self.set_status(Some("off"), None, None);
        }
    }

    /// Output devices for the settings page (id = name).
    pub fn devices() -> Vec<String> {
        cpal::default_host().output_devices().map(|it| it.filter_map(|d| d.name().ok()).collect()).unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn level_like_js() {
        assert_eq!(level(30.0, 60.0), 0.18);
        assert_eq!(level(100.0, 100.0), 1.0);
        assert_eq!(level(250.0, 100.0), 1.0);
        assert_eq!(level(-5.0, 60.0), 0.0);
    }

    #[test]
    fn loop_is_normalised_and_seamless() {
        let ch = make_channel(8000, fastrand::f64);
        assert_eq!(ch.len(), 240_000);
        let peak = ch.iter().fold(0f32, |p, v| p.max(v.abs()));
        assert!((peak - 0.5).abs() < 1e-6, "peak {peak}");
        // the loop point: last sample -> first sample is no bigger a jump than a typical step
        let steps: Vec<f32> = ch.windows(2).map(|w| (w[1] - w[0]).abs()).collect();
        let mean = steps.iter().sum::<f32>() / steps.len() as f32;
        let wrap = (ch[0] - ch[ch.len() - 1]).abs();
        assert!(wrap < mean * 6.0, "wrap jump {wrap} vs mean step {mean}");
    }
}

#[cfg(test)]
mod state_tests {
    use super::*;
    /// No audio device here: on -> error, off -> back to 'off' (JS: the off branch always sets state 'off').
    #[test]
    fn off_after_error_goes_back_to_off() {
        let n = Noise::new();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let s2 = Arc::clone(&seen);
        n.on_status(move |st| s2.lock().unwrap().push(st.state));
        n.set(true, Some(40.0));
        n.set(false, None);
        let v = seen.lock().unwrap().clone();
        eprintln!("{v:?}");
        assert_eq!(v.last().map(String::as_str), Some("off"), "{v:?}");
    }
}
