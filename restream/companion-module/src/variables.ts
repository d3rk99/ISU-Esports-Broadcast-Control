import type ModuleInstance from './main.js'
import type { RestreamValue, RestreamVariables } from './api-client.js'

export type VariablesSchema = Record<string, RestreamValue>
export const MAX_OUTPUTS = 8

// Same names as the keys of Restream's GET /api/state (restream/crates/gui/src/control.rs).
export function variableDefinitions(): Record<string, { name: string }> {
	const d: Record<string, { name: string }> = {
		connection_ok: { name: 'Companion: connected to Restream' },
		state: { name: 'State (IDLE / FILLING / ON AIR / DRAINING)' },
		live: { name: 'Session running (not IDLE)' },
		on_air: { name: 'On air (delayed stream is going out)' },
		delay_seconds: { name: 'Delay: configured seconds' },
		delay_filled_seconds: { name: 'Delay: buffered seconds' },
		on_air_in_seconds: { name: 'Delay: seconds until on air (while filling)' },
		recording: { name: 'Recording is on' },
		recording_seconds: { name: 'Recording length seconds' },
		recording_path: { name: 'Recording file' },
		gain_db: { name: 'Program gain dB' },
		monitor: { name: 'Audio monitor on' },
		monitor_volume_db: { name: 'Audio monitor volume dB' },
		audio_peak_l: { name: 'Audio peak left dBFS' },
		audio_peak_r: { name: 'Audio peak right dBFS' },
		video_fps: { name: 'Encoder fps' },
		video_kbps: { name: 'Encoder video kbps' },
		audio_kbps: { name: 'Encoder audio kbps' },
		error: { name: 'Last error (last 60 s, empty when fine)' },
		profile: { name: 'Profile name' },
		outputs_total: { name: 'Enabled destinations' },
		outputs_live: { name: 'Enabled destinations streaming' },
		all_enabled_live: { name: 'Every enabled destination streaming' },
		dest_count: { name: 'Destinations in the profile' },
	}
	for (let n = 1; n <= MAX_OUTPUTS; n += 1) {
		d[`out${n}_name`] = { name: `Destination ${n}: name` }
		d[`out${n}_enabled`] = { name: `Destination ${n}: enabled` }
		d[`out${n}_state`] = { name: `Destination ${n}: state (STREAMING / CONNECTING / RECONNECTING / LAGGING / STANDBY / STOPPED / DISABLED)` }
		d[`out${n}_live`] = { name: `Destination ${n}: streaming` }
		d[`out${n}_kbps`] = { name: `Destination ${n}: kbps` }
		d[`out${n}_reconnects`] = { name: `Destination ${n}: reconnects` }
	}
	return d
}

export function UpdateVariableDefinitions(self: ModuleInstance): void {
	self.setVariableDefinitions(variableDefinitions())
}

export function emptyVariables(): RestreamVariables {
	return Object.fromEntries(Object.keys(variableDefinitions()).map((id) => [id, '']))
}
