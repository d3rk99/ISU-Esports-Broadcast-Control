import type ModuleInstance from './main.js'
import type { BroadcastVariableValue, BroadcastVariables } from './api-client.js'

export type VariablesSchema = Record<string, BroadcastVariableValue>

type VariableDefinition = { name: string }

export function createVariableDefinitions(): Record<string, VariableDefinition> {
	const definitions: Record<string, VariableDefinition> = {
		connection_ok: { name: 'Controller: Connected' },
		selected_game: { name: 'Match: Selected game' },
		event: { name: 'Match: Event' },
		round: { name: 'Match: Round' },
		format: { name: 'Match: Format' },
		live: { name: 'Match: Live / off-air' },
		home_name: { name: 'Home: Team name' },
		home_short_name: { name: 'Home: Abbreviation' },
		home_color: { name: 'Home: Primary color' },
		home_secondary_color: { name: 'Home: Secondary color' },
		home_score: { name: 'Home: Series score' },
		home_detail_score: { name: 'Home: Current map/game score' },
		away_name: { name: 'Away: Team name' },
		away_short_name: { name: 'Away: Abbreviation' },
		away_color: { name: 'Away: Primary color' },
		away_secondary_color: { name: 'Away: Secondary color' },
		away_score: { name: 'Away: Series score' },
		away_detail_score: { name: 'Away: Current map/game score' },
		active_match_number: { name: 'Match: Active map/game number' },
		active_match_index: { name: 'Match: Active map/game index' },
		active_mode: { name: 'Match: Active mode' },
		active_map: { name: 'Match: Active map/stage' },
		active_status: { name: 'Match: Active status' },
		active_winner: { name: 'Match: Active winner' },
		show_away_roster: { name: 'Roster: Away roster enabled' },
		updated_at: { name: 'Controller: Last state update' },
		rl_connection_status: { name: 'Rocket League: Telemetry status' },
		rl_clock_seconds: { name: 'Rocket League: Game clock seconds' },
		rl_overtime: { name: 'Rocket League: Overtime' },
		rl_arena: { name: 'Rocket League: Arena' },
		rl_spectated_player: { name: 'Rocket League: Spectated player' },
		rl_spectated_team: { name: 'Rocket League: Spectated home/away team' },
		rl_spectated_slot: { name: 'Rocket League: Camera slot (home_1–away_3; blank during replay)' },
		rl_packet_rate: { name: 'Rocket League: Packet rate' },
		rl_packets: { name: 'Rocket League: Packets received' },
		stage_enabled: { name: 'Stage Displays: Manager enabled' },
		stage_online_count: { name: 'Stage Displays: Online station count' },
		stage_expected_client_version: { name: 'Stage Displays: Expected client version' },
		stage_update_available: { name: 'Stage Displays: Client update available' },
		stage_update_version: { name: 'Stage Displays: Published update version' },
		stage_update_size: { name: 'Stage Displays: Published update size bytes' },
		stage_pending_preset: { name: 'Stage Displays: Prepared preset' },
		stage_pending_mode: { name: 'Stage Displays: Prepared mode' },
		stage_pending_ready_count: { name: 'Stage Displays: Prepared ready count' },
		stage_pending_online_count: { name: 'Stage Displays: Prepared online count' },
		stage_pending_all_ready: { name: 'Stage Displays: Prepared cue all ready' },
	}

	for (let number = 1; number <= 7; number += 1) {
		definitions[`match_${number}_mode`] = { name: `Map/Game ${number}: Mode` }
		definitions[`match_${number}_map`] = { name: `Map/Game ${number}: Map/stage` }
		definitions[`match_${number}_status`] = { name: `Map/Game ${number}: Status` }
		definitions[`match_${number}_winner`] = { name: `Map/Game ${number}: Winner` }
		definitions[`match_${number}_home_score`] = { name: `Map/Game ${number}: Home score` }
		definitions[`match_${number}_away_score`] = { name: `Map/Game ${number}: Away score` }
	}

	for (const side of ['home', 'away']) {
		for (let number = 1; number <= 3; number += 1) {
			definitions[`rl_${side}_player_${number}_name`] = { name: `Rocket League ${side} player ${number}: Name` }
			definitions[`rl_${side}_player_${number}_spectated`] = { name: `Rocket League ${side} player ${number}: Spectated` }
		}
	}
	for (let number = 1; number <= 8; number += 1) {
		definitions[`rl_player_${number}_name`] = { name: `Rocket League player ${number}: Name` }
		definitions[`rl_player_${number}_team`] = { name: `Rocket League player ${number}: Team` }
		definitions[`rl_player_${number}_boost`] = { name: `Rocket League player ${number}: Boost` }
		definitions[`rl_player_${number}_goals`] = { name: `Rocket League player ${number}: Goals` }
		definitions[`rl_player_${number}_assists`] = { name: `Rocket League player ${number}: Assists` }
		definitions[`rl_player_${number}_saves`] = { name: `Rocket League player ${number}: Saves` }
		definitions[`rl_player_${number}_shots`] = { name: `Rocket League player ${number}: Shots` }
	}

	for (let number = 1; number <= 10; number += 1) {
		definitions[`stage_station_${number}_online`] = { name: `Stage station ${number}: Online` }
		definitions[`stage_station_${number}_mode`] = { name: `Stage station ${number}: Mode` }
		definitions[`stage_station_${number}_hostname`] = { name: `Stage station ${number}: Hostname` }
		definitions[`stage_station_${number}_client_version`] = { name: `Stage station ${number}: Client version` }
		definitions[`stage_station_${number}_outdated`] = { name: `Stage station ${number}: Outdated` }
		definitions[`stage_station_${number}_updating`] = { name: `Stage station ${number}: Updating` }
		definitions[`stage_station_${number}_update_status`] = { name: `Stage station ${number}: Update status` }
		definitions[`stage_station_${number}_preset`] = { name: `Stage station ${number}: Preset` }
		definitions[`stage_station_${number}_ready`] = { name: `Stage station ${number}: Ready` }
	}

	for (let number = 1; number <= 4; number += 1) {
		definitions[`veto_ban_${number}`] = { name: `VALORANT veto: Ban ${number}` }
	}
	for (let number = 1; number <= 3; number += 1) {
		definitions[`veto_pick_${number}_map`] = { name: `VALORANT veto pick ${number}: Map` }
		definitions[`veto_pick_${number}_attackers`] = { name: `VALORANT veto pick ${number}: Attacking side` }
		definitions[`veto_pick_${number}_home_score`] = { name: `VALORANT veto pick ${number}: Home score` }
		definitions[`veto_pick_${number}_away_score`] = { name: `VALORANT veto pick ${number}: Away score` }
		definitions[`veto_pick_${number}_winner`] = { name: `VALORANT veto pick ${number}: Winner` }
	}

	return definitions
}

export function UpdateVariableDefinitions(self: ModuleInstance): void {
	self.setVariableDefinitions(createVariableDefinitions())
}

export function emptyVariableValues(): BroadcastVariables {
	return Object.fromEntries(Object.keys(createVariableDefinitions()).map((id) => [id, '']))
}
