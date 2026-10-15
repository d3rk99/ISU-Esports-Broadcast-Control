// VALORANT scoreboard reader -> which board block is which TEAM (Derk 2026-10-15).
// The reader only knows "top block" (its 'home') and "bottom block" (its 'away'). That is NOT the match's home/away:
// in Derk's own observer frames Idaho State's opponent sat on top. So before anything uses the board, decide per match:
//   1. NAMES: count how many rows of each block match the home roster vs the away roster (gamertag similarity). A clear
//      majority decides. Rosters are the source of truth (Roster Manager), so this usually settles it in the first sweep.
//   2. SIDES: if names can't decide, use the map pool's ATTACKING SIDE for the active map + which block is tinted red
//      (attackers) / teal (defenders) on the board (reader: board.colors). Teams swap sides at round 13 and every OT round,
//      so the current round (match score) picks first or second half.
//   3. Otherwise keep the last decision (start of the match: top = home).
// mapBoardToTeams() returns the board re-keyed by TEAM: teams.home = the match's home team's 5 players, whatever block
// they are in, plus `decision` for the controller panel.
import { tagSimilarity } from './overwatch-ocr-panel.js';

export const TEAM_MATCH = 0.8;   // a row counts for a roster at >= 80% gamertag similarity

function rosterTags(game, side) {
  const rosters = side === 'home' ? game?.rosters : game?.awayRosters;
  const out = [];
  for (const key of ['varsity', 'jv']) for (const p of rosters?.[key] || []) { const t = String(p?.handle || '').trim(); if (t) out.push(t); }
  return out;
}

function votes(blockPlayers, tags) {
  let n = 0;
  for (const p of blockPlayers || []) {
    if (!p?.name) continue;
    if (tags.some((t) => tagSimilarity(p.name, t) >= TEAM_MATCH)) n += 1;
  }
  return n;
}

// Round number now: rounds played + 1 (the board's round score is the match score of the current map).
export function currentRound(game) {
  const override = Number(game?.valorantRoundOverride?.[game?.activeMap || 0]);
  if (Number.isInteger(override) && override >= 1 && override <= 100) return override;
  const match = game?.valorantBoard?.live?.match;
  if (Number.isFinite(match?.homeScore) && Number.isFinite(match?.awayScore)) return match.homeScore + match.awayScore + 1;
  const h = Number(game?.teams?.[0]?.detailScore) || 0; const a = Number(game?.teams?.[1]?.detailScore) || 0;
  return h + a + 1;
}

// Which TEAM attacks right now: map pool pick's attackers (0 = home, 1 = away) for the first half; swapped in the second
// half (rounds 13-24) and every overtime round alternates (25 = like the first half, 26 = like the second, ...).
export function attackingTeamNow(game) {
  const pick = game?.veto?.picks?.[game?.activeMap || 0];
  if (!pick || (pick.attackers !== 0 && pick.attackers !== 1 && pick.attackers !== '0' && pick.attackers !== '1')) return '';
  const first = Number(pick.attackers) === 1 ? 'away' : 'home';
  const round = currentRound(game);
  const swapped = round <= 12 ? false : round <= 24 ? true : (round - 25) % 2 === 1;
  return swapped ? (first === 'home' ? 'away' : 'home') : first;
}

// -> { top: 'home'|'away', by: 'names'|'sides'|'kept'|'default', detail }
export function decideBlocks(game, board, previous = null) {
  const top = board?.teams?.home?.players || []; const bottom = board?.teams?.away?.players || [];
  const homeTags = rosterTags(game, 'home'); const awayTags = rosterTags(game, 'away');
  const v = { topHome: votes(top, homeTags), topAway: votes(top, awayTags), bottomHome: votes(bottom, homeTags), bottomAway: votes(bottom, awayTags) };
  const straight = v.topHome + v.bottomAway; const crossed = v.topAway + v.bottomHome;
  const detail = `names ${straight}:${crossed}`;
  if (straight >= 2 && straight >= crossed + 2) return { top: 'home', by: 'names', detail };
  if (crossed >= 2 && crossed >= straight + 2) return { top: 'away', by: 'names', detail };
  // Names undecided: attacking side from the map pool + the board's red (attackers) block.
  const attacking = attackingTeamNow(game);
  const colors = board?.colors || {};
  if (attacking && (colors.home === 'red' || colors.away === 'red' || colors.home === 'teal' || colors.away === 'teal')) {
    const topIsAttackers = colors.home === 'red' || colors.away === 'teal';
    const topTeam = topIsAttackers ? attacking : (attacking === 'home' ? 'away' : 'home');
    return { top: topTeam, by: 'sides', detail: `${detail}, ${attacking} attacking, top block ${colors.home || '?'}` };
  }
  if (previous?.top) return { top: previous.top, by: 'kept', detail };
  return { top: 'home', by: 'default', detail };
}

// Board (top/bottom blocks) -> board by TEAM. Each player keeps `row` (row inside his block) and gets `block`.
export function mapBoardToTeams(game, board, previous = null) {
  if (!board?.teams) return { board, decision: previous || { top: 'home', by: 'default', detail: '' } };
  const decision = decideBlocks(game, board, previous);
  const tag = (block) => (board.teams[block]?.players || []).map((p) => ({ ...p, block: block === 'home' ? 'top' : 'bottom' }));
  const topTeam = decision.top; const bottomTeam = topTeam === 'home' ? 'away' : 'home';
  const teams = { [topTeam]: { players: tag('home') }, [bottomTeam]: { players: tag('away') } };
  return { board: { ...board, teams, blocks: { top: topTeam, bottom: bottomTeam } }, decision };
}
