'use strict';
// Flat values for Companion variables / feedbacks / triggers. Only measured state: no keys, no URLs.
const MAX_OUTPUTS = 8; // stable variable slots out1..out8 so Companion definitions never change shape

function companionVariables(s) {
  const problems = s.programHealth?.problems || [];
  const v = {
    engine: s.engine || '', simulation: Boolean(s.simulation), error: s.error || '',
    program_healthy: Boolean(s.programHealth?.healthy), program_problems: problems.join(','),
    encoder: s.encoder || '', codec: s.codec || '', fps: Number(Number(s.telemetry?.fps || 0).toFixed(2)),
    bitrate_kbps: s.telemetry?.currentBitrateKbps || 0, dropped_frames: s.telemetry?.droppedFrames || 0,
    signal: Boolean(s.input?.connected),
    delay_seconds: s.buffer?.configuredSeconds || 0, delay_filled_seconds: Math.floor(s.buffer?.filledSeconds || 0),
    delay_ready: Boolean(s.buffer?.ready),
    delay_percent: s.buffer?.configuredSeconds ? Math.min(100, Math.floor(100 * (s.buffer.filledSeconds || 0) / s.buffer.configuredSeconds)) : (s.buffer?.ready ? 100 : 0),
    outputs_locked: Boolean(s.outputsLocked),
    recording: ['RECORDING', 'WAITING_KEYFRAME'].includes(s.recording?.state), recording_state: s.recording?.state || 'STOPPED',
    recording_seconds: s.recording?.seconds || 0,
    audio_peak_l: Math.round(s.preview?.peakDb?.[0] ?? -90), audio_peak_r: Math.round(s.preview?.peakDb?.[1] ?? -90),
    audio_silent: problems.includes('SILENT') || problems.includes('NO_AUDIO'),
    uptime_seconds: Math.floor(s.uptime || 0)
  };
  const outputs = s.outputs || [];
  for (let n = 1; n <= MAX_OUTPUTS; n += 1) {
    const o = outputs[n - 1];
    v[`out${n}_name`] = o ? (o.name || `Output ${n}`) : '';
    v[`out${n}_state`] = o ? o.state : 'NONE';
    v[`out${n}_live`] = Boolean(o?.live);
    v[`out${n}_healthy`] = Boolean(o?.healthy);
    v[`out${n}_health`] = o ? (o.health || 'OFF') : 'NONE';
    v[`out${n}_reconnects`] = o?.reconnectCount || 0;
  }
  const enabled = outputs.filter((o) => o.state !== 'DISABLED');
  v.outputs_total = enabled.length;
  v.outputs_live = enabled.filter((o) => o.live).length;
  v.outputs_healthy = enabled.filter((o) => o.healthy).length;
  v.any_live = v.outputs_live > 0;
  v.all_enabled_live = enabled.length > 0 && v.outputs_live === enabled.length;
  v.all_enabled_healthy = v.all_enabled_live && v.outputs_healthy === enabled.length && v.program_healthy;
  return v;
}

module.exports = { companionVariables, MAX_OUTPUTS };
