//! The Rust pink noise loop equals the real JS noise.js makeBuffer, sample for sample, given the
//! same random numbers (parity-noise.json from rust/scripts/parity-noise.cjs).
#[path = "../src/noise.rs"]
#[allow(dead_code)]
mod noise;

#[test]
fn pink_noise_matches_js_sample_for_sample() {
    let c: serde_json::Value = serde_json::from_str(include_str!("parity-noise.json")).unwrap();
    let r: Vec<f64> = c["randoms"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect();
    let rate = c["rate"].as_u64().unwrap() as u32;
    let per = r.len() / 2;
    let mut it = r[..per].iter().copied();
    let left = noise::make_channel(rate, || it.next().unwrap());
    let mut it2 = r[per..].iter().copied();
    let right = noise::make_channel(rate, || it2.next().unwrap());
    assert_eq!(left.len() as u64, c["len"].as_u64().unwrap());
    let idx = [0usize, 1, 2, 3, 199, 200, 399, 400, 401, 5000, 11999];
    for (k, i) in idx.iter().enumerate() {
        assert_eq!(f64::from(left[*i]), c["left"][k].as_f64().unwrap(), "left[{i}]");
        assert_eq!(f64::from(right[*i]), c["right"][k].as_f64().unwrap(), "right[{i}]");
    }
    assert_eq!(f64::from(left.iter().fold(0f32, |p, v| p.max(v.abs()))), c["peakL"].as_f64().unwrap());
    assert_eq!(noise::level(30.0, 60.0), c["level"].as_f64().unwrap());
}
