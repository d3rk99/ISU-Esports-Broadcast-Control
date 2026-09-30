import type ModuleInstance from './main.js'

type Team = 'home' | 'away'
type Operation = 'increment' | 'decrement'
type ProgramOutput = 'scoreboard' | 'roster' | 'map-pool' | 'clean'
type StageMode = 'gameplay' | 'wall' | 'graphic' | 'individual' | 'hold' | 'blackout'
type StageUpdateTarget = 'outdated' | 'all' | 'station'

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
	stage_global_mode: { options: { mode: StageMode } }
	stage_station_mode: { options: { station: string; mode: StageMode } }
	stage_assign_mode_preset: { options: { preset: string; mode: StageMode; wallTotal: string; wallGroup: string } }
	stage_prepare_preset: { options: { preset: string; mode: StageMode; wallTotal: string; wallGroup: string } }
	stage_fire_prepared: { options: { executeDelaySeconds: number } }
	stage_play_preset: { options: { preset: string; mode: StageMode; wallTotal: string; wallGroup: string; executeDelaySeconds: number } }
	stage_client_update: { options: { target: StageUpdateTarget; station: string } }
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

const STAGE_MODE_CHOICES = [
	{ id: 'gameplay', label: 'Gameplay Mirror' },
	{ id: 'wall', label: 'Wall / Span' },
	{ id: 'graphic', label: 'Mirror Graphic' },
	{ id: 'individual', label: 'Individual' },
	{ id: 'hold', label: 'Hold Graphic' },
	{ id: 'blackout', label: 'Blackout' },
]

const STATION_CHOICES = Array.from({ length: 10 }, (_item, index) => ({
	id: String(index + 1),
	label: `Station ${String(index + 1).padStart(2, '0')}`,
}))

const WALL_GROUP_CHOICES = [
	{ id: '', label: 'All / default' },
	{ id: '1-5', label: 'Stations 1-5' },
	{ id: '6-10', label: 'Stations 6-10' },
	{ id: 'mirror-5', label: 'Mirror 1-5 and 6-10' },
	{ id: '10', label: '10-screen span' },
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
		stage_global_mode: {
			name: 'Stage Displays: Set global mode',
			options: [{ id: 'mode', type: 'dropdown', label: 'Mode', default: 'blackout', choices: STAGE_MODE_CHOICES }],
			callback: async (event) => self.sendControlAction({ action: 'stage.mode.set', mode: event.options.mode }),
		},
		stage_station_mode: {
			name: 'Stage Displays: Set station mode',
			options: [
				{ id: 'station', type: 'dropdown', label: 'Station', default: '1', choices: STATION_CHOICES },
				{ id: 'mode', type: 'dropdown', label: 'Mode', default: 'blackout', choices: STAGE_MODE_CHOICES },
			],
			callback: async (event) =>
				self.sendControlAction({
					action: 'stage.station.mode.set',
					station: event.options.station,
					mode: event.options.mode,
				}),
		},
		stage_assign_mode_preset: {
			name: 'Stage Displays: Assign preset to mode',
			options: [
				{ id: 'preset', type: 'textinput', label: 'Preset name', default: 'starting-soon', useVariables: true },
				{ id: 'mode', type: 'dropdown', label: 'Mode', default: 'wall', choices: STAGE_MODE_CHOICES },
				{ id: 'wallTotal', type: 'textinput', label: 'Wall total', default: '10', useVariables: true },
				{ id: 'wallGroup', type: 'dropdown', label: 'Wall group', default: '10', choices: WALL_GROUP_CHOICES },
			],
			callback: async (event) =>
				self.sendControlAction({
					action: 'stage.mode.assign_preset',
					preset: event.options.preset,
					mode: event.options.mode,
					wallTotal: event.options.wallTotal,
					wallGroup: event.options.wallGroup,
				}),
		},
		stage_prepare_preset: {
			name: 'Stage Displays: Prepare preset',
			options: [
				{ id: 'preset', type: 'textinput', label: 'Preset name', default: 'starting-soon', useVariables: true },
				{ id: 'mode', type: 'dropdown', label: 'Mode', default: 'graphic', choices: STAGE_MODE_CHOICES },
				{ id: 'wallTotal', type: 'textinput', label: 'Wall total', default: '10', useVariables: true },
				{ id: 'wallGroup', type: 'dropdown', label: 'Wall group', default: '', choices: WALL_GROUP_CHOICES },
			],
			callback: async (event) =>
				self.sendControlAction({
					action: 'stage.preset.prepare',
					preset: event.options.preset,
					mode: event.options.mode,
					wallTotal: event.options.wallTotal,
					wallGroup: event.options.wallGroup,
				}),
		},
		stage_fire_prepared: {
			name: 'Stage Displays: Fire prepared preset',
			options: [
				{ id: 'executeDelaySeconds', type: 'number', label: 'Sync delay seconds', default: 1, min: 0.2, max: 10, step: 0.1 },
			],
			callback: async (event) =>
				self.sendControlAction({
					action: 'stage.prepared.play',
					executeDelaySeconds: event.options.executeDelaySeconds,
				}),
		},
		stage_play_preset: {
			name: 'Stage Displays: Play preset',
			options: [
				{ id: 'preset', type: 'textinput', label: 'Preset name', default: 'starting-soon', useVariables: true },
				{ id: 'mode', type: 'dropdown', label: 'Mode', default: 'graphic', choices: STAGE_MODE_CHOICES },
				{ id: 'wallTotal', type: 'textinput', label: 'Wall total', default: '10', useVariables: true },
				{ id: 'wallGroup', type: 'dropdown', label: 'Wall group', default: '', choices: WALL_GROUP_CHOICES },
				{ id: 'executeDelaySeconds', type: 'number', label: 'Sync delay seconds', default: 1.5, min: 0.2, max: 10, step: 0.1 },
			],
			callback: async (event) =>
				self.sendControlAction({
					action: 'stage.preset.play',
					preset: event.options.preset,
					mode: event.options.mode,
					wallTotal: event.options.wallTotal,
					wallGroup: event.options.wallGroup,
					executeDelaySeconds: event.options.executeDelaySeconds,
				}),
		},
		stage_client_update: {
			name: 'Stage Displays: Send client update',
			options: [
				{
					id: 'target',
					type: 'dropdown',
					label: 'Target',
					default: 'outdated',
					choices: [
						{ id: 'outdated', label: 'Outdated online clients' },
						{ id: 'all', label: 'All online clients' },
						{ id: 'station', label: 'One station' },
					],
				},
				{ id: 'station', type: 'dropdown', label: 'Station if one station', default: '1', choices: STATION_CHOICES },
			],
			callback: async (event) =>
				self.sendControlAction({
					action: 'stage.client.update',
					target: event.options.target,
					station: event.options.target === 'station' ? event.options.station : '',
				}),
		},
	})
}
