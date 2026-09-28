import type { CompanionPresetDefinitions, CompanionPresetSection } from '@companion-module/base'
import type ModuleInstance from './main.js'
import type { ModuleSchema } from './main.js'

const BLACK = 0x101012
const WHITE = 0xffffff
const ORANGE = 0xf47920
const GREEN = 0x2e7d32
const RED = 0xc62828
const GRAY = 0x333338
const BLUE = 0x2d8cff
const YELLOW = 0xffce47

function scorePreset(name: string, team: 'home' | 'away', operation: 'increment' | 'decrement', detail = false) {
	const side = team === 'home' ? 'HOME' : 'AWAY'
	const sign = operation === 'increment' ? '+' : '−'
	return {
		type: 'simple' as const,
		name,
		style: {
			text: `${side}\n${detail ? 'GAME ' : ''}${sign}1`,
			size: 'auto' as const,
			color: WHITE,
			bgcolor: operation === 'increment' ? GREEN : RED,
			show_topbar: false,
		},
		steps: [
			{
				down: [
					{
						actionId: detail ? ('detail_score_adjust' as const) : ('series_score_adjust' as const),
						options: { team, operation, amount: 1 },
					},
				],
				up: [],
			},
		],
		feedbacks: [],
	}
}

export function UpdatePresets(self: ModuleInstance): void {
	const structure: CompanionPresetSection<ModuleSchema>[] = [
		{
			id: 'match-control',
			name: 'Match Control',
			definitions: [
				{
					id: 'primary',
					name: 'Primary controls',
					description: 'Ready-made buttons for the main scorekeeping page',
					type: 'simple',
					presets: [
						'home-plus',
						'home-minus',
						'away-plus',
						'away-minus',
						'next-match',
						'live-toggle',
						'swap-teams',
						'reset-scores',
					],
				},
				{
					id: 'detail',
					name: 'Current map/game score',
					description: 'Manual in-map or in-game score controls',
					type: 'simple',
					presets: ['home-detail-plus', 'home-detail-minus', 'away-detail-plus', 'away-detail-minus'],
				},
			],
		},
		{
			id: 'program-output',
			name: 'Program Output',
			definitions: [
				{
					id: 'program',
					name: 'Program output selection',
					description: 'Switch the persistent Fill+Key program output without reopening projector windows',
					type: 'simple',
					presets: ['program-scoreboard', 'program-roster', 'program-map-pool', 'program-clean'],
				},
			],
		},
		{
			id: 'stage-displays',
			name: 'Stage Displays',
			definitions: [
				{
					id: 'stage-primary',
					name: 'Primary stage controls',
					description: 'Control the audience-facing station displays',
					type: 'simple',
					presets: [
						'stage-gameplay',
						'stage-blackout',
						'stage-hold',
						'stage-prepare-starting',
						'stage-fire-prepared',
						'stage-update-outdated',
					],
				},
			],
		},
	]

	const presets: CompanionPresetDefinitions<ModuleSchema> = {
		'home-plus': scorePreset('Home series score +1', 'home', 'increment'),
		'home-minus': scorePreset('Home series score −1', 'home', 'decrement'),
		'away-plus': scorePreset('Away series score +1', 'away', 'increment'),
		'away-minus': scorePreset('Away series score −1', 'away', 'decrement'),
		'home-detail-plus': scorePreset('Home current score +1', 'home', 'increment', true),
		'home-detail-minus': scorePreset('Home current score −1', 'home', 'decrement', true),
		'away-detail-plus': scorePreset('Away current score +1', 'away', 'increment', true),
		'away-detail-minus': scorePreset('Away current score −1', 'away', 'decrement', true),
		'next-match': {
			type: 'simple',
			name: 'Next map/game',
			style: { text: 'NEXT\nMATCH', size: 'auto', color: WHITE, bgcolor: GREEN, show_topbar: false },
			steps: [{ down: [{ actionId: 'next_match', options: {} }], up: [] }],
			feedbacks: [],
		},
		'live-toggle': {
			type: 'simple',
			name: 'Toggle overlay live',
			style: { text: 'TAKE\nLIVE', size: 'auto', color: WHITE, bgcolor: GRAY, show_topbar: false },
			steps: [{ down: [{ actionId: 'live_state', options: { mode: 'toggle' } }], up: [] }],
			feedbacks: [
				{
					feedbackId: 'is_live',
					options: {},
					style: { text: 'ON AIR', color: WHITE, bgcolor: RED },
				},
			],
		},
		'swap-teams': {
			type: 'simple',
			name: 'Swap teams',
			style: { text: 'SWAP\nTEAMS', size: 'auto', color: WHITE, bgcolor: ORANGE, show_topbar: false },
			steps: [{ down: [{ actionId: 'swap_teams', options: {} }], up: [] }],
			feedbacks: [],
		},
		'reset-scores': {
			type: 'simple',
			name: 'Reset all scores',
			style: { text: 'RESET\nSCORES', size: 'auto', color: WHITE, bgcolor: BLACK, show_topbar: false },
			steps: [{ down: [{ actionId: 'reset_scores', options: {} }], up: [] }],
			feedbacks: [],
		},
		'program-scoreboard': programOutputPreset('Scoreboard', 'scoreboard'),
		'program-roster': programOutputPreset('Roster', 'roster'),
		'program-map-pool': programOutputPreset('Map Pool', 'map-pool'),
		'program-clean': programOutputPreset('Clean', 'clean'),
		'stage-gameplay': stageModePreset('Gameplay Mirror', 'GAMEPLAY', 'gameplay', GREEN),
		'stage-blackout': stageModePreset('Blackout', 'BLACKOUT', 'blackout', BLACK),
		'stage-hold': stageModePreset('Hold Graphic', 'HOLD', 'hold', GRAY),
		'stage-prepare-starting': {
			type: 'simple',
			name: 'Stage: Prepare starting-soon',
			style: { text: 'PREP\nSTARTING', size: 'auto', color: WHITE, bgcolor: BLUE, show_topbar: false },
			steps: [
				{
					down: [
						{
							actionId: 'stage_prepare_preset',
							options: { preset: 'starting-soon', mode: 'graphic', wallTotal: '10', wallGroup: '' },
						},
					],
					up: [],
				},
			],
			feedbacks: [
				{
					feedbackId: 'stage_prepared_ready',
					options: {},
					style: { text: 'READY\nFIRE', color: WHITE, bgcolor: GREEN },
				},
			],
		},
		'stage-fire-prepared': {
			type: 'simple',
			name: 'Stage: Fire prepared cue',
			style: { text: 'FIRE\nSTAGE', size: 'auto', color: WHITE, bgcolor: ORANGE, show_topbar: false },
			steps: [{ down: [{ actionId: 'stage_fire_prepared', options: { executeDelaySeconds: 1 } }], up: [] }],
			feedbacks: [
				{
					feedbackId: 'stage_prepared_ready',
					options: {},
					style: { color: WHITE, bgcolor: GREEN },
				},
			],
		},
		'stage-update-outdated': {
			type: 'simple',
			name: 'Stage: Update outdated clients',
			style: { text: 'UPDATE\nCLIENTS', size: 'auto', color: BLACK, bgcolor: YELLOW, show_topbar: false },
			steps: [{ down: [{ actionId: 'stage_client_update', options: { target: 'outdated', station: '1' } }], up: [] }],
			feedbacks: [],
		},
	}

	self.setPresetDefinitions(structure, presets)
}

function stageModePreset(name: string, text: string, mode: 'gameplay' | 'blackout' | 'hold', color: number) {
	return {
		type: 'simple' as const,
		name: `Stage: ${name}`,
		style: {
			text: `STAGE\n${text}`,
			size: 'auto' as const,
			color: WHITE,
			bgcolor: color,
			show_topbar: false,
		},
		steps: [{ down: [{ actionId: 'stage_global_mode' as const, options: { mode } }], up: [] }],
		feedbacks: [],
	}
}

function programOutputPreset(label: string, output: 'scoreboard' | 'roster' | 'map-pool' | 'clean') {
	return {
		type: 'simple' as const,
		name: `Program output: ${label}`,
		style: {
			text: `PGM\n${label.toUpperCase().replace(' ', '\n')}`,
			size: 'auto' as const,
			color: WHITE,
			bgcolor: BLACK,
			show_topbar: false,
		},
		steps: [{ down: [{ actionId: 'select_program_output' as const, options: { output } }], up: [] }],
		feedbacks: [
			{
				feedbackId: 'program_output_selected' as const,
				options: { output },
				style: { color: WHITE, bgcolor: output === 'clean' ? GRAY : BLUE },
			},
		],
	}
}
