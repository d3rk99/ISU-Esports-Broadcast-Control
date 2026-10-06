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
			id: 'displays',
			name: 'Displays',
			definitions: [
				{
					id: 'display-modes',
					name: 'Game mirror / NDI (all stations)',
					type: 'simple',
					presets: ['display-mirror', 'display-ndi'],
				},
				{
					id: 'display-groups',
					name: 'Stations 1-5 / 6-10',
					description: 'Control each half of the stage on its own (two matches at once)',
					type: 'simple',
					presets: ['display-a-mirror', 'display-a-ndi', 'display-a-player', 'display-a-banner', 'display-b-mirror', 'display-b-ndi', 'display-b-player', 'display-b-banner'],
				},
				{
					id: 'display-presets',
					name: 'NDI presets (all stations)',
					type: 'simple',
					presets: ['display-idle', 'display-intro', 'display-player', 'display-banner', 'display-score', 'display-black'],
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
		'display-mirror': displayModePreset('GAME\nMIRROR', 'mirror', GREEN),
		'display-ndi': displayModePreset('NDI\nFEED', 'ndi', BLUE),
		'display-idle': displayPreset('Idle', 'IDLE', 'idle', GRAY),
		'display-intro': displayPreset('Team intro', 'TEAM\nINTRO', 'intro', ORANGE),
		'display-player': displayPreset('Player cards', 'PLAYER\nCARDS', 'player', ORANGE),
		'display-banner': displayPreset('Team banners', 'TEAM\nBANNERS', 'banner', ORANGE),
		'display-score': displayPreset('Series score', 'SERIES\nSCORE', 'score', ORANGE),
		'display-black': displayPreset('Black', 'BLACK', 'black', BLACK),
		'display-a-mirror': displayModePreset('1-5\nMIRROR', 'mirror', GREEN, '1-5'),
		'display-a-ndi': displayModePreset('1-5\nNDI', 'ndi', BLUE, '1-5'),
		'display-a-player': displayPreset('1-5 player cards', '1-5\nCARDS', 'player', ORANGE, '1-5'),
		'display-a-banner': displayPreset('1-5 banners', '1-5\nBANNER', 'banner', ORANGE, '1-5'),
		'display-b-mirror': displayModePreset('6-10\nMIRROR', 'mirror', GREEN, '6-10'),
		'display-b-ndi': displayModePreset('6-10\nNDI', 'ndi', BLUE, '6-10'),
		'display-b-player': displayPreset('6-10 player cards', '6-10\nCARDS', 'player', ORANGE, '6-10'),
		'display-b-banner': displayPreset('6-10 banners', '6-10\nBANNER', 'banner', ORANGE, '6-10'),
	}

	self.setPresetDefinitions(structure, presets)
}

function displayModePreset(text: string, mode: 'mirror' | 'ndi', color: number, station = '') {
	return {
		type: 'simple' as const,
		name: `Displays: ${mode === 'mirror' ? 'Game mirror' : 'NDI'} (${station || 'all'})`,
		style: { text, size: 'auto' as const, color: WHITE, bgcolor: color, show_topbar: false },
		steps: [{ down: [{ actionId: 'display_mode' as const, options: { station, mode } }], up: [] }],
		feedbacks: [],
	}
}

function displayPreset(name: string, text: string, preset: 'idle' | 'intro' | 'player' | 'banner' | 'score' | 'black', color: number, station = '') {
	return {
		type: 'simple' as const,
		name: `Displays: ${name} (${station || 'all'})`,
		style: { text, size: 'auto' as const, color: WHITE, bgcolor: color, show_topbar: false },
		steps: [{ down: [{ actionId: 'display_preset' as const, options: { station, preset, team: '' as const } }], up: [] }],
		feedbacks: [
			{ feedbackId: 'display_preset' as const, options: { station: station === '6-10' ? '6' : '1', preset }, style: { color: BLACK, bgcolor: GREEN } },
		],
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
