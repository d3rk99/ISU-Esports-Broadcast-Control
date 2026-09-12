import type ModuleInstance from './main.js'

export type FeedbacksSchema = {
	controller_connected: { type: 'boolean'; options: Record<string, never> }
	is_live: { type: 'boolean'; options: Record<string, never> }
	selected_game: { type: 'boolean'; options: { game: string } }
	program_output_selected: { type: 'boolean'; options: { output: string } }
	team_leading: { type: 'boolean'; options: { team: 'home' | 'away'; scoreType: 'series' | 'detail' } }
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
	})
}
