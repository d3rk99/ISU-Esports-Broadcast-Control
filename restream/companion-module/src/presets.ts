import type { CompanionPresetDefinitions, CompanionPresetSection } from '@companion-module/base'
import type ModuleInstance from './main.js'
import type { ModuleSchema } from './main.js'
import { AMBER, BLUE, GREEN, RED, WHITE } from './feedbacks.js'

const BLACK = 0x101012
const ORANGE = 0xf47920
const GRAY = 0x333338
const t = (text: string, bgcolor = GRAY, color = WHITE) => ({ text, size: 'auto' as const, color, bgcolor, show_topbar: false })

function outputPreset(L: string, n: number) {
	return {
		type: 'simple' as const,
		name: `Destination ${n}: status tile`,
		style: t(`$(${L}:out${n}_name)\n$(${L}:out${n}_state)`),
		steps: [],
		feedbacks: [
			{ feedbackId: 'output_live' as const, options: { output: String(n) }, style: { bgcolor: GREEN, color: WHITE } },
			{ feedbackId: 'output_problem' as const, options: { output: String(n) }, style: { bgcolor: AMBER, color: WHITE } },
		],
	}
}

export function UpdatePresets(self: ModuleInstance): void {
	const L = self.label
	const structure: CompanionPresetSection<ModuleSchema>[] = [
		{
			id: 'restream',
			name: 'Restream',
			definitions: [
				{ id: 'transport', name: 'Go live / stop / record', type: 'simple', presets: ['go-live', 'stop', 'cut', 'record', 'state'] },
				{ id: 'audio', name: 'Audio', type: 'simple', presets: ['gain-down', 'gain', 'gain-up', 'monitor', 'mon-down', 'mon-up', 'meter'] },
				{ id: 'outputs', name: 'Destinations', type: 'simple', presets: ['out-1', 'out-2', 'out-3', 'out-4'] },
			],
		},
	]
	const presets: CompanionPresetDefinitions<ModuleSchema> = {
		'go-live': {
			type: 'simple',
			name: 'GO LIVE (state colour: filling amber, on air red)',
			style: t('GO\nLIVE'),
			steps: [{ down: [{ actionId: 'go_live', options: {} }], up: [] }],
			feedbacks: [
				{ feedbackId: 'filling', options: {}, style: { text: `FILLING\n$(${L}:on_air_in_seconds)s`, bgcolor: AMBER, color: WHITE } },
				{ feedbackId: 'on_air', options: {}, style: { text: `ON AIR\n$(${L}:outputs_live)/$(${L}:outputs_total)`, bgcolor: RED, color: WHITE } },
				{ feedbackId: 'connected', options: {}, isInverted: true, style: { text: 'NO\nRESTREAM', bgcolor: BLACK, color: WHITE } },
			],
		},
		stop: {
			type: 'simple',
			name: 'STOP (plays out the buffer)',
			style: t('STOP', BLACK),
			steps: [{ down: [{ actionId: 'stop', options: {} }], up: [] }],
			feedbacks: [{ feedbackId: 'draining', options: {}, style: { text: 'STOPPING\n…', bgcolor: AMBER, color: WHITE } }],
		},
		cut: {
			type: 'simple',
			name: 'CUT (hold 1 s: discards the buffer)',
			style: t('HOLD\nTO CUT', 0x5a1010),
			steps: [{ down: [], up: [], 1000: { options: { runWhileHeld: true }, actions: [{ actionId: 'cut', options: {} }] } }],
			feedbacks: [],
		},
		record: {
			type: 'simple',
			name: 'Record toggle',
			style: t('● REC'),
			steps: [{ down: [{ actionId: 'recording', options: { operation: 'toggle' } }], up: [] }],
			feedbacks: [{ feedbackId: 'recording', options: {}, style: { text: `● REC\n$(${L}:recording_seconds)s`, bgcolor: RED, color: WHITE } }],
		},
		state: {
			type: 'simple',
			name: 'State + delay tile',
			style: t(`$(${L}:state)\n$(${L}:delay_filled_seconds)/$(${L}:delay_seconds)s`, ORANGE, BLACK),
			steps: [],
			feedbacks: [
				{ feedbackId: 'error', options: {}, style: { text: `ERROR\n$(${L}:error)`, bgcolor: RED, color: WHITE } },
				{ feedbackId: 'connected', options: {}, isInverted: true, style: { text: 'NO\nRESTREAM', bgcolor: BLACK, color: WHITE } },
			],
		},
		'gain-down': { type: 'simple', name: 'Gain -1 dB', style: t('GAIN\n-1'), steps: [{ down: [{ actionId: 'gain_adjust', options: { db: -1 } }], up: [] }], feedbacks: [] },
		gain: { type: 'simple', name: 'Gain (press = 0 dB)', style: t(`GAIN\n$(${L}:gain_db) dB`), steps: [{ down: [{ actionId: 'gain_set', options: { db: 0 } }], up: [] }], feedbacks: [] },
		'gain-up': { type: 'simple', name: 'Gain +1 dB', style: t('GAIN\n+1'), steps: [{ down: [{ actionId: 'gain_adjust', options: { db: 1 } }], up: [] }], feedbacks: [] },
		monitor: {
			type: 'simple',
			name: 'Audio monitor toggle',
			style: t(`MONITOR\n$(${L}:monitor_volume_db) dB`),
			steps: [{ down: [{ actionId: 'monitor', options: { operation: 'toggle' } }], up: [] }],
			feedbacks: [{ feedbackId: 'monitor', options: {}, style: { bgcolor: BLUE, color: WHITE } }],
		},
		'mon-down': { type: 'simple', name: 'Monitor -3 dB', style: t('MON\n-3'), steps: [{ down: [{ actionId: 'monitor_volume_adjust', options: { db: -3 } }], up: [] }], feedbacks: [] },
		'mon-up': { type: 'simple', name: 'Monitor +3 dB', style: t('MON\n+3'), steps: [{ down: [{ actionId: 'monitor_volume_adjust', options: { db: 3 } }], up: [] }], feedbacks: [] },
		meter: {
			type: 'simple',
			name: 'Audio peak tile (red when above -1 dBFS)',
			style: t(`AUDIO\n$(${L}:audio_peak_l) / $(${L}:audio_peak_r)`),
			steps: [],
			feedbacks: [{ feedbackId: 'audio_clipping', options: {}, style: { bgcolor: RED, color: WHITE } }],
		},
		'out-1': outputPreset(L, 1),
		'out-2': outputPreset(L, 2),
		'out-3': outputPreset(L, 3),
		'out-4': outputPreset(L, 4),
	}
	self.setPresetDefinitions(structure, presets)
}
