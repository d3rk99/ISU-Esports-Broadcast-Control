import type ModuleInstance from './main.js'

type Team = 'home' | 'away'
type Operation = 'increment' | 'decrement'
type ProgramOutput = 'scoreboard' | 'roster' | 'map-pool' | 'clean'

export type ActionsSchema = {
	series_score_adjust: { options: { team: Team; operation: Operation; amount: number } }
	series_score_set: { options: { team: Team; value: string } }
	detail_score_adjust: { options: { team: Team; operation: Operation; amount: number } }
	detail_score_set: { options: { team: Team; value: string } }
	next_match: { options: Record<string, never> }
	reset_scores: { options: Record<string, never> }
	live_state: { options: { mode: 'toggle' | 'on' | 'off' } }
	swap_teams: { options: Record<string, never> }
	select_game: { options: { game: string } }
	activate_map: { options: { number: string } }
	set_map_winner: { options: { number: string; team: Team | 'clear' } }
	reset_maps: { options: Record<string, never> }
	reset_valorant_veto: { options: Record<string, never> }
	select_program_output: { options: { output: ProgramOutput } }
}

const TEAM_CHOICES = [
	{ id: 'home', label: 'Home' },
	{ id: 'away', label: 'Away' },
]

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

export function UpdateActions(self: ModuleInstance): void {
	self.setActionDefinitions({
		series_score_adjust: {
			name: 'Series score: Increase / decrease',
			options: [
				{ id: 'team', type: 'dropdown', label: 'Team', default: 'home', choices: TEAM_CHOICES },
				{
					id: 'operation',
					type: 'dropdown',
					label: 'Operation',
					default: 'increment',
					choices: [
						{ id: 'increment', label: 'Increase' },
						{ id: 'decrement', label: 'Decrease' },
					],
				},
				{ id: 'amount', type: 'number', label: 'Amount', default: 1, min: 1, max: 20 },
			],
			callback: async (event) => {
				await self.sendControlAction({
					action: `score.${event.options.operation}`,
					team: event.options.team,
					amount: event.options.amount,
				})
			},
		},
		series_score_set: {
			name: 'Series score: Set value',
			options: [
				{ id: 'team', type: 'dropdown', label: 'Team', default: 'home', choices: TEAM_CHOICES },
				{ id: 'value', type: 'textinput', label: 'Score', default: '0', useVariables: true },
			],
			callback: async (event) =>
				self.sendControlAction({ action: 'score.set', team: event.options.team, value: event.options.value }),
		},
		detail_score_adjust: {
			name: 'Current map/game score: Increase / decrease',
			options: [
				{ id: 'team', type: 'dropdown', label: 'Team', default: 'home', choices: TEAM_CHOICES },
				{
					id: 'operation',
					type: 'dropdown',
					label: 'Operation',
					default: 'increment',
					choices: [
						{ id: 'increment', label: 'Increase' },
						{ id: 'decrement', label: 'Decrease' },
					],
				},
				{ id: 'amount', type: 'number', label: 'Amount', default: 1, min: 1, max: 100 },
			],
			callback: async (event) => {
				await self.sendControlAction({
					action: `detail_score.${event.options.operation}`,
					team: event.options.team,
					amount: event.options.amount,
				})
			},
		},
		detail_score_set: {
			name: 'Current map/game score: Set value',
			options: [
				{ id: 'team', type: 'dropdown', label: 'Team', default: 'home', choices: TEAM_CHOICES },
				{ id: 'value', type: 'textinput', label: 'Score', default: '0', useVariables: true },
			],
			callback: async (event) =>
				self.sendControlAction({ action: 'detail_score.set', team: event.options.team, value: event.options.value }),
		},
		next_match: {
			name: 'Advance to next map/game',
			options: [],
			callback: async () => self.sendControlAction({ action: 'match.next' }),
		},
		reset_scores: {
			name: 'Reset all team scores',
			options: [],
			callback: async () => self.sendControlAction({ action: 'scores.reset' }),
		},
		live_state: {
			name: 'Set overlay live state',
			options: [
				{
					id: 'mode',
					type: 'dropdown',
					label: 'State',
					default: 'toggle',
					choices: [
						{ id: 'toggle', label: 'Toggle' },
						{ id: 'on', label: 'Take live' },
						{ id: 'off', label: 'Take off air' },
					],
				},
			],
			callback: async (event) =>
				self.sendControlAction(
					event.options.mode === 'toggle'
						? { action: 'match.live.toggle' }
						: { action: 'match.live.set', value: event.options.mode === 'on' },
				),
		},
		swap_teams: {
			name: 'Swap Home and Away teams',
			options: [],
			callback: async () => self.sendControlAction({ action: 'teams.swap' }),
		},
		select_game: {
			name: 'Select active game',
			options: [{ id: 'game', type: 'dropdown', label: 'Game', default: 'overwatch', choices: GAME_CHOICES }],
			callback: async (event) => self.sendControlAction({ action: 'game.select', game: event.options.game }),
		},
		activate_map: {
			name: 'Activate map/game number',
			options: [{ id: 'number', type: 'textinput', label: 'Map/game number', default: '1', useVariables: true }],
			callback: async (event) => self.sendControlAction({ action: 'map.activate', number: event.options.number }),
		},
		set_map_winner: {
			name: 'Set map/game winner',
			options: [
				{ id: 'number', type: 'textinput', label: 'Map/game number', default: '1', useVariables: true },
				{
					id: 'team',
					type: 'dropdown',
					label: 'Winner',
					default: 'home',
					choices: [...TEAM_CHOICES, { id: 'clear', label: 'Clear winner' }],
				},
			],
			callback: async (event) =>
				self.sendControlAction({ action: 'map.winner.set', number: event.options.number, team: event.options.team }),
		},
		reset_maps: {
			name: 'Reset map/game results',
			options: [],
			callback: async () => self.sendControlAction({ action: 'maps.reset' }),
		},
		reset_valorant_veto: {
			name: 'VALORANT: Reset veto selections',
			options: [],
			callback: async () => self.sendControlAction({ action: 'veto.reset', game: 'valorant' }),
		},
		select_program_output: {
			name: 'Program output: Select HTML',
			options: [
				{ id: 'output', type: 'dropdown', label: 'Output', default: 'scoreboard', choices: PROGRAM_OUTPUT_CHOICES },
			],
			callback: async (event) => self.sendControlAction({ action: 'output.select', output: event.options.output }),
		},
	})
}
