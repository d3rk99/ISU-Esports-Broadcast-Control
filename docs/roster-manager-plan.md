# Roster Manager + VALORANT reader identity (Derk 2026-10-15)

## What Derk asked
1. A ROSTER MANAGER sub-tab inside the Roster tab: create teams, add players (gamertag, name, headshot), mark them
   starter / 6th man / substitute / coach, varsity or JV; manage many players at once. It is the source of truth for the
   match roster AND for the scoreboard reader.
2. The reader links a pre-set roster player to a scoreboard row automatically, by gamertag similarity (a % confidence).
3. Use the map pool's ATTACKING SIDE to know which board team is Idaho State.
4. VALORANT re-sorts its scoreboard during the match: the reader must follow players, not rows.

## Research (2026-10-15)
- Scoreboard order: since Patch 13.06 (live 2026-09-22) the scoreboard position and MVP are decided by the new
  PERFORMANCE SCORE (0-500), which replaced ACS (official VALORANT patch notes 13.06, x.com/VALORANT article
  2102387565579882564; wiki.playvalorant.com/en-us/Patch_Notes/13.06; thespike.gg; gameriv.com). Riot has NOT published the
  formula, so we can't predict the order -> we must not depend on it at all. Any row can swap with any other row of the
  same team at any moment (each team sorted separately, top block and bottom block).
- Which team is on top of the spectator Tab board: no public source found. The reader today simply calls the top block
  "home" and the bottom block "away" (valorant-board-parse.cjs PROFILE.rowOffsets home = top 5, away = bottom 5). In
  Derk's test frame the bottom block is the LCU team, so top/bottom is NOT tied to Idaho State. It has to be decided per
  match: by matching gamertags to the rosters first, and the map pool attacking side as the rule when names don't decide.
  ASSUMPTION to confirm with Derk on a live board: does the top block follow attackers/defenders, or stay the same team
  for the whole map? The code supports both (it re-checks every sweep).

## What was wrong in the code
- valorant-board-parse applySweep + BoardConsensus key every value by `side:row:field`. When two players swap rows, the
  new player's kills/deaths/name have to win a 2-4 read streak against the old player's values: for a few seconds a row
  shows a MIX of two players, and K/D/A "going down" is treated as suspicious (needs 4 reads). The name needs 3 reads.
- syncValorantRoster fills EMPTY roster slots with board names. With rows swapping and names half-read, it auto-adds
  wrong/partial gamertags and keeps them (autoAdded) - that is what scrambled the roster + stations.
- The reader's "home"/"away" = top/bottom block, never checked against which block is really ISU.

## Plan
A. Reader follows PLAYERS: per sweep, every row's name read is matched to the known players of that block (consensus
   name history + roster gamertags). A row whose read name belongs to another known player moves that player's data
   with it (no streak fight). K/D/A per player id, not per row. Unknown rows keep the row behaviour.
B. Block -> team: count roster gamertag matches in the top and bottom block (home roster vs away roster); the side with
   the clear majority wins. If names can't decide (start of map, nobody typed in), use the active map's ATTACKING SIDE
   + which block shows the attacking colour, as configured. Result: board.blockTeam = { top: 'home'|'away', ... } and
   the controller mirrors the board into game.valorantBoard.live.teams.home/away by TEAM, so everything downstream
   (overlay cards, spectate candidates, stations) is team-correct.
C. Roster sync never auto-fills from a row that isn't stable; links roster player <-> board player by % similarity with a
   visible confidence; a link once made sticks to the player (gamertag), not the row.
D. Roster Manager sub-tab: a TEAM LIBRARY (state.rosterLibrary: teams[] with players[]: gamertag, name, headshot,
   status starter|sixth|sub|coach, program varsity|jv, station) + "Load into match" for home / away. Bulk add (paste a
   list), bulk status/program change. Library is saved per game.

## Built (2026-10-15)
- A: electron/valorant-board-identity.cjs (BoardIdentity) + valorant-board-service.cjs: reads re-keyed from board row to
  player slot each sweep; players carry `row` = where they are on the board now. Tests: test/valorant-board-identity.test.cjs.
- B: electron/valorant-board-parse.cjs blockColor() (teal/red per block, both real fixtures read top teal / bottom red) +
  src/valorant-board-teams.js (names -> map pool attacking side + colour -> last decision). Controller publishes the board
  by TEAM. Reader panel shows "TOP BLOCK · <team> (HOME/AWAY) · ATTACKING/DEFENDING" and how it decided.
  Tests: test/valorant-board-teams.test.js.
- C: syncValorantRoster never adds board names to a pre-set roster, never adds a near-copy (>= 60%) of a roster name.
  Match roster rows show a READER chip: LINKED / MAYBE <board name> · NN% · agent.
- D: src/roster-manager.js + src/roster-manager-view.js: Roster tab -> ROSTER MANAGER | MATCH ROSTER sub-tabs.
  Tests: test/roster-manager.test.js. Checked in a headless browser: bulk add, load as home -> match roster
  Sn0wfal..Ishnarb, SixthGuy, Benchy (coach + JV kept out of varsity), no page errors.

## Still needs a live check by Derk
- Top block colour: proven on 2 frames only (both had defenders on top). If VALORANT's spectator board keeps the same
  team on top all match, the names decide anyway; the colour rule is only the fallback.
- Second half / OT swap uses the match score (detailScore); a wrong score = wrong fallback side (names still win).
