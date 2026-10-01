import type { CompanionPresetDefinitions, CompanionPresetSection } from '@companion-module/base'
import type ModuleInstance from './main.js'
import type { ModuleSchema } from './main.js'

const BLACK = 0x101012
const WHITE = 0xffffff
const ORANGE = 0xf47920
const GREEN = 0x2e7d32
const RED = 0xc62828
const GRAY = 0x333338
const AMBER = 0xb26a00

function outputPreset(L: string, n: number) {
	return {
		type: 'simple' as const,
		name: `Destination ${n}: toggle with live/health colour`,
		style: {
			text: `$(${L}:out${n}_name)\n$(${L}:out${n}_health)`,
			size: 'auto' as const,
			color: WHITE,
			bgcolor: GRAY,
			show_topbar: false,
		},
		steps: [
			{
				down: [{ actionId: 'output_control' as const, options: { output: String(n), operation: 'toggle' as const } }],
				up: [],
			},
		],
		// Order matters: later feedbacks win. Problem (amber) beats live (red); healthy (green) wins when fine.
		feedbacks: [
			{ feedbackId: 'output_live' as const, options: { output: String(n) }, style: { bgcolor: RED, color: WHITE } },
			{
				feedbackId: 'output_healthy' as const,
				options: { output: String(n) },
				style: { bgcolor: GREEN, color: WHITE },
			},
			{
				feedbackId: 'output_problem' as const,
				options: { output: String(n) },
				style: { bgcolor: AMBER, color: WHITE },
			},
		],
	}
}

export function UpdatePresets(self: ModuleInstance): void {
	const L = self.label
	const structure: CompanionPresetSection<ModuleSchema>[] = [
		{
			id: 'stream',
			name: 'Stream Control',
			definitions: [
				{
					id: 'main',
					name: 'Main page',
					description: 'Go live, stop, record and status tiles',
					type: 'simple',
					presets: ['start-all', 'stop-all', 'record', 'health', 'delay', 'audio'],
				},
				{
					id: 'outputs',
					name: 'Destinations',
					description: 'One button per destination: press to toggle, colour = live / healthy / problem',
					type: 'simple',
					presets: ['out-1', 'out-2', 'out-3', 'out-4'],
				},
			],
		},
	]
	const presets: CompanionPresetDefinitions<ModuleSchema> = {
		'start-all': {
			type: 'simple',
			name: 'START ALL (locked until delay ready)',
			style: {
				text: `GO LIVE\n$(${L}:delay_percent)%`,
				size: 'auto',
				color: WHITE,
				bgcolor: GRAY,
				show_topbar: false,
			},
			steps: [{ down: [{ actionId: 'stream_start_all', options: {} }], up: [] }],
			feedbacks: [
				{ feedbackId: 'delay_ready', options: {}, style: { text: 'GO LIVE\nREADY', bgcolor: GREEN, color: WHITE } },
				{
					feedbackId: 'any_live',
					options: {},
					style: {
						text: `ON AIR\n$(${L}:outputs_healthy)/$(${L}:outputs_total) OK`,
						bgcolor: RED,
						color: WHITE,
					},
				},
				{ feedbackId: 'all_healthy', options: {}, style: { text: 'ON AIR\nALL OK', bgcolor: GREEN, color: WHITE } },
			],
		},
		'stop-all': {
			type: 'simple',
			name: 'STOP ALL',
			style: { text: 'STOP\nALL', size: 'auto', color: WHITE, bgcolor: BLACK, show_topbar: false },
			steps: [{ down: [{ actionId: 'stream_stop_all', options: {} }], up: [] }],
			feedbacks: [],
		},
		record: {
			type: 'simple',
			name: 'Record toggle',
			style: { text: '● REC', size: 'auto', color: WHITE, bgcolor: GRAY, show_topbar: false },
			steps: [{ down: [{ actionId: 'recording', options: { operation: 'toggle' } }], up: [] }],
			feedbacks: [
				{
					feedbackId: 'recording',
					options: {},
					style: { text: `● REC\n$(${L}:recording_seconds)s`, bgcolor: RED, color: WHITE },
				},
			],
		},
		health: {
			type: 'simple',
			name: 'Program health tile',
			style: {
				text: `PROGRAM\n$(${L}:fps) fps`,
				size: 'auto',
				color: WHITE,
				bgcolor: GREEN,
				show_topbar: false,
			},
			steps: [],
			feedbacks: [
				{
					feedbackId: 'program_problem',
					options: {},
					style: { text: `PROBLEM\n$(${L}:program_problems)`, bgcolor: AMBER, color: WHITE },
				},
				{
					feedbackId: 'connected',
					options: {},
					isInverted: true,
					style: { text: 'NO\nSERVER', bgcolor: BLACK, color: WHITE },
				},
			],
		},
		delay: {
			type: 'simple',
			name: 'Delay tile',
			style: {
				text: `DELAY\n$(${L}:delay_filled_seconds)/$(${L}:delay_seconds)s`,
				size: 'auto',
				color: BLACK,
				bgcolor: ORANGE,
				show_topbar: false,
			},
			steps: [],
			feedbacks: [
				{
					feedbackId: 'delay_ready',
					options: {},
					style: { text: `DELAY\n$(${L}:delay_seconds)s ✓`, bgcolor: GREEN, color: WHITE },
				},
			],
		},
		audio: {
			type: 'simple',
			name: 'Audio tile',
			style: {
				text: `AUDIO\n$(${L}:audio_peak_l) / $(${L}:audio_peak_r)`,
				size: 'auto',
				color: WHITE,
				bgcolor: GRAY,
				show_topbar: false,
			},
			steps: [],
			feedbacks: [
				{ feedbackId: 'audio_silent', options: {}, style: { text: 'NO\nAUDIO', bgcolor: AMBER, color: WHITE } },
			],
		},
		'out-1': outputPreset(L, 1),
		'out-2': outputPreset(L, 2),
		'out-3': outputPreset(L, 3),
		'out-4': outputPreset(L, 4),
	}
	self.setPresetDefinitions(structure, presets)
}
