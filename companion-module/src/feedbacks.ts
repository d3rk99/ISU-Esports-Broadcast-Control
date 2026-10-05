import type ModuleInstance from './main.js'

export type FeedbacksSchema = {
	controller_connected: { type: 'boolean'; options: Record<string, never> }
	is_live: { type: 'boolean'; options: Record<string, never> }
	selected_game: { type: 'boolean'; options: { game: string } }
	program_output_selected: { type: 'boolean'; options: { output: string } }
	team_leading: { type: 'boolean'; options: { team: 'home' | 'away'; scoreType: 'series' | 'detail' } }
	stage_station_online: { type: 'boolean'; options: { station: string } }
	stage_station_mode: { type: 'boolean'; options: { station: string; mode: string } }
	stage_station_outdated: { type: 'boolean'; options: { station: string } }
	stage_station_updating: { type: 'boolean'; options: { station: string } }
	stage_prepared_ready: { type: 'boolean'; options: Record<string, never> }
}

const GAME_CHOICES = [
	{ id: 'overwatch', label: 'Overwatch 2' },
	{ id: 'valorant', label: 'VALORANT' },
	{ id: 'rocketleague', label: 'Rocket League' },
	{ id: 'smash', label: 'Smash Bros. Ultimate' },
	{ id: 'callofduty', label: 'Call of Duty' },
]

const PROGRAM_OUTPUT_CHOICES = [
	{ id: 'scoreboard', label: 'Scoreboard' },
	{ id: 'roster', label: 'Roster' },
	{ id: 'map-pool', label: 'Map Pool' },
	{ id: 'clean', label: 'Clean' },
]

const STATION_CHOICES = Array.from({ length: 10 }, (_item, index) => ({
	id: String(index + 1),
	label: `Station ${String(index + 1).padStart(2, '0')}`,
}))

const STAGE_MODE_CHOICES = [
	{ id: 'gameplay', label: 'Gameplay Mirror' },
	{ id: 'wall', label: 'Wall / Span' },
	{ id: 'graphic', label: 'Mirror Graphic' },
	{ id: 'individual', label: 'Individual' },
	{ id: 'playercard', label: 'Player Card (NDI)' },
	{ id: 'hold', label: 'Hold Graphic' },
	{ id: 'blackout', label: 'Blackout' },
	{ id: 'offline', label: 'Offline' },
]

export function UpdateFeedbacks(self: ModuleInstance): void {
	self.setFeedbackDefinitions({
		controller_connected: {
			name: 'Controller is connected',
			type: 'boolean',
			defaultStyle: { bgcolor: 0x2e7d32, color: 0xffffff },
			options: [],
			callback: () => self.getVariableValue('connection_ok') === true,
		},
		is_live: {
			name: 'Overlay is live',
			type: 'boolean',
			defaultStyle: { bgcolor: 0xc62828, color: 0xffffff },
			options: [],
			callback: () => self.getVariableValue('live') === true,
		},
		selected_game: {
			name: 'Selected game',
			type: 'boolean',
			defaultStyle: { bgcolor: 0xf47920, color: 0x101012 },
			options: [{ id: 'game', type: 'dropdown', label: 'Game', default: 'overwatch', choices: GAME_CHOICES }],
			callback: (feedback) => self.getVariableValue('selected_game') === feedback.options.game,
		},
		program_output_selected: {
			name: 'Program output is selected',
			type: 'boolean',
			defaultStyle: { bgcolor: 0x2d8cff, color: 0xffffff },
			options: [
				{ id: 'output', type: 'dropdown', label: 'Output', default: 'scoreboard', choices: PROGRAM_OUTPUT_CHOICES },
			],
			callback: (feedback) => self.getVariableValue('active_output_overlay') === feedback.options.output,
		},
		team_leading: {
			name: 'Team is leading',
			type: 'boolean',
			defaultStyle: { bgcolor: 0x2e7d32, color: 0xffffff },
			options: [
				{
					id: 'team',
					type: 'dropdown',
					label: 'Team',
					default: 'home',
					choices: [
						{ id: 'home', label: 'Home' },
						{ id: 'away', label: 'Away' },
					],
				},
				{
					id: 'scoreType',
					type: 'dropdown',
					label: 'Score',
					default: 'series',
					choices: [
						{ id: 'series', label: 'Series score' },
						{ id: 'detail', label: 'Current map/game score' },
					],
				},
			],
			callback: (feedback) => {
				const suffix = feedback.options.scoreType === 'detail' ? '_detail_score' : '_score'
				const own = Number(self.getVariableValue(`${feedback.options.team}${suffix}`)) || 0
				const opponent =
					Number(self.getVariableValue(`${feedback.options.team === 'home' ? 'away' : 'home'}${suffix}`)) || 0
				return own > opponent
			},
		},
		stage_station_online: {
			name: 'Stage station is online',
			type: 'boolean',
			defaultStyle: { bgcolor: 0x2e7d32, color: 0xffffff },
			options: [{ id: 'station', type: 'dropdown', label: 'Station', default: '1', choices: STATION_CHOICES }],
			callback: (feedback) => self.getVariableValue(`stage_station_${feedback.options.station}_online`) === true,
		},
		stage_station_mode: {
			name: 'Stage station is in mode',
			type: 'boolean',
			defaultStyle: { bgcolor: 0x2d8cff, color: 0xffffff },
			options: [
				{ id: 'station', type: 'dropdown', label: 'Station', default: '1', choices: STATION_CHOICES },
				{ id: 'mode', type: 'dropdown', label: 'Mode', default: 'gameplay', choices: STAGE_MODE_CHOICES },
			],
			callback: (feedback) =>
				self.getVariableValue(`stage_station_${feedback.options.station}_mode`) === feedback.options.mode,
		},
		stage_station_outdated: {
			name: 'Stage station needs update',
			type: 'boolean',
			defaultStyle: { bgcolor: 0xffce47, color: 0x101012 },
			options: [{ id: 'station', type: 'dropdown', label: 'Station', default: '1', choices: STATION_CHOICES }],
			callback: (feedback) => self.getVariableValue(`stage_station_${feedback.options.station}_outdated`) === true,
		},
		stage_station_updating: {
			name: 'Stage station is updating',
			type: 'boolean',
			defaultStyle: { bgcolor: 0xf47920, color: 0x101012 },
			options: [{ id: 'station', type: 'dropdown', label: 'Station', default: '1', choices: STATION_CHOICES }],
			callback: (feedback) => self.getVariableValue(`stage_station_${feedback.options.station}_updating`) === true,
		},
		stage_prepared_ready: {
			name: 'Stage prepared cue is ready on all online stations',
			type: 'boolean',
			defaultStyle: { bgcolor: 0x2e7d32, color: 0xffffff },
			options: [],
			callback: () => self.getVariableValue('stage_pending_all_ready') === true,
		},
	})
}
