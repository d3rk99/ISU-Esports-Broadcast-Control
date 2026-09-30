# Rocket League player cameras and stat card

Import Companion module 0.1.3 and connect it to the updated controller. Enable Rocket League player synchronization and receive live bridge data (or use Run Test Feed).

- `rl_home_player_1_name` through `rl_home_player_3_name`
- `rl_away_player_1_name` through `rl_away_player_3_name`
- Corresponding `_spectated` booleans
- `rl_spectated_slot`: `home_1`, `home_2`, `home_3`, `away_1`, `away_2`, `away_3`, or empty
- `rl_spectated_team`: home, away, or empty
- Existing `rl_spectated_player`: the telemetry player name

Create Companion variable-change triggers with conditions on `rl_spectated_slot` and actions on your Blackmagic connection. Ignore the empty value. No switcher actions are automatically installed. Test on preview before routing program.

Slots are sorted by Rocket League spectator shortcut within each team (ID/name breaks ties). Home/away follows the controller blue-team assignment. These are game slots, NOT permanent physical station assignments: verify names and camera inputs at every match, team swap, or player substitution. For fixed-camera players, trigger using the name and require a nonempty spectated slot.

The scoreboard automatically shows the spectated player's shots, goals, assists, saves and demos. It uses the selected Varsity/JV roster for that team, matching the in-game name to a unique roster handle or name (case-insensitive). Upload a headshot under Player Image. Missing/failed headshots fall back to the team logo, then abbreviation if the logo is unavailable. Ambiguous roster matches use the logo.

The card and camera routing signals hide/clear during replay, unavailable telemetry or reported data age of 3 seconds. The bridge protocol is unchanged. Telemetry delivery and Companion trigger processing add latency; this is not frame-accurate video synchronization.
