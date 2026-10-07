// Runs public/displays/station.js against a tiny fake DOM (no browser) and checks the player card.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fakeDom() {
  const els = new Map();
  const make = (id) => {
    const el = {
      id, textContent: '', hidden: false, dataset: {}, children: [], attrs: {}, style: { _v: {}, setProperty(k, v) { this._v[k] = v; }, removeProperty(k) { delete this._v[k]; } },
      classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle(c, on) { if (on === undefined ? !this._s.has(c) : on) this._s.add(c); else this._s.delete(c); }, contains(c) { return this._s.has(c); } },
      get className() { return [...this.classList._s].join(' '); },
      set className(v) { this.classList._s = new Set(String(v).split(/\s+/).filter(Boolean)); },
      get offsetWidth() { return 0; }, get clientWidth() { return 800; }, get scrollWidth() { return 400; },
      get parentElement() { return els.get('__copy'); },
      get naturalWidth() { return 1600; }, get naturalHeight() { return 800; },
      setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k] ?? null; }, removeAttribute(k) { delete this.attrs[k]; },
      replaceChildren(...c) { this.children = c; }, append(...c) { this.children.push(...c); }, querySelector() { return null; }
    };
    Object.defineProperty(el, 'src', { get() { return el.attrs.src; }, set(v) { el.attrs.src = String(v); }, configurable: true });
    return el;
  };
  const document = {
    getElementById(id) { if (!els.has(id)) els.set(id, make(id)); return els.get(id); },
    createElement(tag) { const e = make(tag); e.tag = tag; Object.defineProperty(e, 'innerText', { get() { return [this.textContent, ...this.children.map((c) => c.textContent ?? c)].join(' ').trim(); } }); return e; },
    createTextNode(t) { return String(t); },
    fonts: { ready: Promise.resolve() }
  };
  return { document, els };
}

function loadStation(station = 1, initialState = {}) {
  const { document, els } = fakeDom();
  class FakeImage { set src(v) { this._src = v; setTimeout(() => this.onload?.(), 0); } get src() { return this._src; } }
  const window = { innerWidth: 1920, innerHeight: 1080, addEventListener() {}, isuLiveState: () => {} };
  const ctx = { window, document, location: { search: `?station=${station}` }, URLSearchParams, Image: FakeImage, setTimeout, console,
    getComputedStyle: () => ({ paddingRight: '0' }), fetch: async (url) => ({ json: async () => (String(url).includes('/api/state') ? initialState : {}) }), requestAnimationFrame: (f) => setTimeout(f, 0) };
  ctx.window.window = ctx.window; Object.assign(ctx.window, { document });
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/displays/station.js'), 'utf8'), ctx);
  return { render: ctx.window.__station.render, $: (id) => document.getElementById(id), els };
}

const rlState = (live) => ({ selectedGame: 'rocketleague', activeRoster: 'varsity', displays: { stations: { 1: { preset: 'player', team: '' } } },
  games: { rocketleague: { teams: [{ name: 'IDAHO STATE', color: '#f47920' }, { name: 'BOISE STATE' }], match: {}, mapRows: [],
    rocketLeague: { live },
    rosters: { varsity: [{ handle: 'D3RK99', name: 'Derek', role: 'Striker', character: 'Fennec', characterImage: '/user-assets/fennec.png', stageStation: 1 }] }, awayRosters: { varsity: [] } } } });

// Player cards run between matches: they show the LAST game (saved when it ended), never live.
test('station player card (Rocket League): car background + LAST GAME stats only, live feed ignored, no boost meter', async () => {
  const state = rlState({ overtime: false, players: [{ name: 'D3RK_99', score: 999, goals: 9, boost: 64 }] });
  state.games.rocketleague.mapRows = [{ map: 'DFH Stadium' }]; state.games.rocketleague.activeMap = 0;
  state.games.rocketleague.lastGameStats = { 1: { game: 'rocketleague', handle: 'D3RK99', map: 'DFH Stadium', stats: { score: 412, goals: 2, assists: 1, saves: 3, shots: 5, demos: 1 } } };
  const page = loadStation(1, state);
  page.render(state);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(page.$('player-hero-img').getAttribute('src'), '/user-assets/fennec.png', 'car PNG from the roster');
  assert.ok(page.$('player-hero-img').classList.contains('is-car'));
  assert.equal(page.$('player-stats-label').textContent, 'LAST GAME · DFH STADIUM');
  const stats = page.$('player-stats').children.map((d) => d.children.map((c) => c.textContent).join(' '));
  assert.deepEqual(stats, ['412 SCORE', '2 GOALS', '1 ASSISTS', '3 SAVES', '5 SHOTS', '1 DEMOS'], 'saved last game, not the live 999');
  assert.ok(!fs.readFileSync(path.join(__dirname, '../public/displays/station.html'), 'utf8').includes('player-boost'), 'no boost meter on the card');
  assert.equal(page.$('player-meta').textContent, 'Derek · Striker · Fennec');
});

test('station player card (Rocket League): nothing saved yet = no stats (even with a live match), car still shown', async () => {
  const state = rlState({ players: [{ name: 'D3RK99', score: 412, goals: 2 }] });
  const page = loadStation(1, state);
  page.render(state);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(page.$('player-stats').children.length, 0);
  assert.equal(page.$('player-stats-label').textContent, '');
  assert.equal(page.$('player-hero-img').getAttribute('src'), '/user-assets/fennec.png');
});

test('station player card: Varsity and JV on stage together (each station finds its player in either roster)', async () => {
  const mk = (handle, station) => ({ handle, name: '', role: 'Striker', character: 'Octane', stageStation: station });
  const state = { selectedGame: 'rocketleague', activeRoster: 'varsity', displays: { stations: { 2: { preset: 'player' }, 5: { preset: 'player' } } },
    games: { rocketleague: { teams: [{ name: 'IDAHO STATE' }, { name: 'BOISE STATE' }], match: {}, mapRows: [], rocketLeague: { live: { players: [] } },
      rosters: { varsity: [mk('VARS1', 1), mk('VARS2', 2), mk('VARS3', 3)], jv: [mk('JV1', 4), mk('JV2', 5), mk('JV3', 6)] }, awayRosters: { varsity: [], jv: [] } } } };
  for (const [station, expected] of [[2, 'VARS2'], [5, 'JV2']]) {
    const page = loadStation(station, state);
    page.render(state);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(page.$('player-handle').textContent, expected, `station ${station}`);
  }
  // JV open in the controller: still finds Varsity at 2
  const jvOpen = { ...state, activeRoster: 'jv' };
  const page = loadStation(2, jvOpen); page.render(jvOpen); await new Promise((r) => setTimeout(r, 20));
  assert.equal(page.$('player-handle').textContent, 'VARS2');
});

test('station player card (VALORANT): last map K / D / A only (no creds, ult or weapon), agent art from the saved map', async () => {
  const state = {
    selectedGame: 'valorant', activeRoster: 'varsity', displays: { stations: { 1: { preset: 'player', team: '' } } },
    games: { valorant: {
      teams: [{ name: 'IDAHO STATE', color: '#f47920' }, { name: 'LCU', color: '#2d6cdf' }],
      characterArt: { 'KAY/O': { url: '/assets/valorant/agents/kay-o.webp' }, Viper: { url: '/assets/valorant/agents/viper.webp' } },
      rosters: { varsity: [{ handle: 'Sn0wfal', stageStation: 1, role: 'Controller', character: '' }] },
      awayRosters: { varsity: [] },
      // live board says something else: the card must ignore it
      valorantBoard: { live: { teams: { home: { players: [{ name: 'Sn0wfal', agent: 'viper', kills: 20, deaths: 1, assists: 1, credits: 2600 }] }, away: { players: [] } } } },
      lastGameStats: { 1: { game: 'valorant', handle: 'SnOwfal', map: 'Ascent', character: 'kay-o', stats: { kills: 18, deaths: 12, assists: 6 } } }
    } }
  };
  const page = loadStation(1, state);
  page.render(state);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(page.$('player-hero-img').getAttribute('src'), '/assets/valorant/agents/kay-o.webp', 'agent from the saved map (slug kay-o -> KAY/O)');
  assert.equal(page.$('player-stats-label').textContent, 'LAST MAP · ASCENT');
  const stats = page.$('player-stats').children.map((d) => d.children.map((c) => c.textContent).join(' '));
  assert.deepEqual(stats, ['18 KILLS', '12 DEATHS', '6 ASSISTS']);
  assert.ok(page.$('player-meta').textContent.includes('KAY/O'));
});
