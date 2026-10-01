import type ModuleInstance from './main.js'
import type { StreamValue, StreamVariables } from './api-client.js'

export type VariablesSchema = Record<string, StreamValue>
export const MAX_OUTPUTS = 8

export function variableDefinitions(): Record<string, { name: string }> {
	const d: Record<string, { name: string }> = {
		connection_ok: { name: 'Companion: Connected to Stream Server' },
		engine: { name: 'Engine state (RUNNING / STARTING / STOPPED / ERROR / SIMULATION)' },
		simulation: { name: 'Engine is in SIMULATION mode (no real media)' },
		error: { name: 'Engine error text (empty when fine)' },
		program_healthy: { name: 'Program healthy (encoder, fps, audio, delay all OK)' },
		program_problems: {
			name: 'Program problems (comma list: ENCODER, LOW_FPS, DROPPED_FRAMES, NO_AUDIO, SILENT, BUFFERING)',
		},
		encoder: { name: 'Encoder state' },
		codec: { name: 'Encoder codec (h264_nvenc / libx264)' },
		fps: { name: 'Encoder measured fps' },
		bitrate_kbps: { name: 'Encoder measured bitrate kbps' },
		dropped_frames: { name: 'Encoder dropped frames' },
		signal: { name: 'Input has signal' },
		delay_seconds: { name: 'Delay: configured seconds' },
		delay_filled_seconds: { name: 'Delay: filled seconds' },
		delay_percent: { name: 'Delay: fill percent' },
		delay_ready: { name: 'Delay: ready (outputs may start)' },
		outputs_locked: { name: 'Outputs locked by the delay interlock' },
		recording: { name: 'Recording is on' },
		recording_state: { name: 'Recording state' },
		recording_seconds: { name: 'Recording length seconds' },
		audio_peak_l: { name: 'Audio peak left dBFS' },
		audio_peak_r: { name: 'Audio peak right dBFS' },
		audio_silent: { name: 'Audio missing or silent for 10 s+' },
		uptime_seconds: { name: 'Encoder uptime seconds' },
		outputs_total: { name: 'Enabled destinations' },
		outputs_live: { name: 'Enabled destinations live (connected)' },
		outputs_healthy: { name: 'Enabled destinations healthy (connected + data flowing)' },
		any_live: { name: 'Any destination live' },
		all_enabled_live: { name: 'Every enabled destination live' },
		all_enabled_healthy: { name: 'Every enabled destination healthy AND program healthy' },
	}
	for (let n = 1; n <= MAX_OUTPUTS; n += 1) {
		d[`out${n}_name`] = { name: `Destination ${n}: Name` }
		d[`out${n}_state`] = {
			name: `Destination ${n}: State (STOPPED / CONNECTING / CONNECTED / RECONNECTING / ERROR / DISABLED / NONE)`,
		}
		d[`out${n}_live`] = { name: `Destination ${n}: Live` }
		d[`out${n}_healthy`] = { name: `Destination ${n}: Healthy` }
		d[`out${n}_health`] = {
			name: `Destination ${n}: Health (HEALTHY / STALLED / LAGGING / FAILED / STARTING / OFF / DISABLED)`,
		}
		d[`out${n}_reconnects`] = { name: `Destination ${n}: Reconnect count` }
	}
	return d
}

export function UpdateVariableDefinitions(self: ModuleInstance): void {
	self.setVariableDefinitions(variableDefinitions())
}

export function emptyVariables(): StreamVariables {
	return Object.fromEntries(Object.keys(variableDefinitions()).map((id) => [id, '']))
}
