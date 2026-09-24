const test = require('node:test');
const assert = require('node:assert/strict');
const { WebSocket } = require('ws');
const net = require('node:net');
const { ValorantOcrService, chooseOcrConsensus, normalizeSettings } = require('../electron/valorant-ocr-service.cjs');
const { getValorantOcrProfile } = require('../electron/valorant-ocr-profiles.cjs');

function fakeFrame(now = Date.now()) {
  return { sourceName: 'VALORANT', capturedAt: now, width: 1920, height: 1080, image: {} };
}

test('Bandit is accepted as a training weapon while unknown weapons are rejected', async () => {
  const service = new ValorantOcrService({});
  await assert.rejects(service.saveLoadoutTemplate({ weapon: 'Bandit' }), /Capture service is unavailable/);
  await assert.rejects(service.saveLoadoutTemplate({ weapon: 'not-a-weapon' }), /Choose a valid weapon/);
  const appSource = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/app.js'), 'utf8');
  assert.match(appSource, /VALORANT_LOADOUT_TEMPLATE_WEAPONS = \[[\s\S]*?'bandit'/);
});

test('grid batch runs four cells while score OCR remains available and reset discards pending results', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let started = 0;
  const service = new ValorantOcrService({
    now: () => 1000,
    capture: { crop: () => ({ image: Buffer.from('x') }) },
    ocr: { recognize: async (_image, recipe) => {
      if (recipe.fieldId.startsWith('observer3-')) {
        started++;
        await gate;
        return { text: 'OldName', confidence: 0.99 };
      }
      return { text: recipe.fieldId === 'timer' ? '1:20' : '2', confidence: 0.99 };
    } }
  });
  t.after(() => service.stop());
  service.settings = normalizeSettings({ enabled: true, profileId: '1920x1080-en-observer3-scoreboard', observerConcurrency: 4 });
  service.latestFrame = fakeFrame(1000);
  const grid = service.observerTick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started, 4);
  assert.equal(service.observer3.activeCells.length, 4);
  assert.equal(await service.ocrTick(), true);
  assert.equal(service.observerBusy, true);
  service.clearState();
  release();
  await grid;
  assert.equal(service.observer3.teams.home.players.some((player) => player.name === 'OldName'), false);
});

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

test('OCR settings constrain capture rate, backend, and ROI geometry', () => {
  const settings = normalizeSettings({ captureFps: 99, captureBackend: 'native', recordedVideoMode: true, roiOverrides: { timer: { x: -10, y: 5, w: 99999, h: 60 } } });
  assert.equal(settings.captureFps, 15);
  assert.equal(settings.recordedVideoMode, true);
  assert.equal(settings.captureBackend, 'native');
  assert.equal(settings.roiOverrides.timer.x, 0);
  assert.equal(settings.roiOverrides.timer.w, 1920);
});

test('service turns fake OCR readings into normalized state', async (t) => {
  let now = 1000;
  const states = [];
  const capture = {
    capture: async () => fakeFrame(now),
    crop: () => ({ image: Buffer.from('test') }),
    snapshot: () => ({ frameDataUrl: 'data:image/png;base64,test', crops: {} }),
    listWindows: async () => [{ id: 'window:1', name: 'VALORANT' }]
  };
  const textByField = { homeScore: '2', timer: '1:30', awayScore: '1' };
  const ocr = { recognize: async (_image, recipe) => ({ text: textByField[recipe.fieldId], confidence: 0.99, latencyMs: 4 }) };
  const service = new ValorantOcrService({ capture, ocr, onState: (state) => states.push(state), now: () => now });
  t.after(() => service.stop());
  service.settings = normalizeSettings({ enabled: true });
  await service.tick();
  now += 400;
  await service.tick();
  now += 400;
  await service.tick();
  const latest = states.at(-1);
  assert.equal(latest.fields.homeScore.value, 2);
  assert.equal(latest.fields.timer.displayValue, '1:30');
  assert.equal(latest.fields.awayScore.value, 1);
  assert.equal(latest.source, 'valorant-ocr');
  assert.equal(latest.capture.width, 1920);
  assert.equal(latest.teams.home.score, 2);
  assert.equal(latest.match.timerSeconds, 90);
  assert.equal(service.status.state, 'reading');
  assert.deepEqual(await service.listWindows(), [{ id: 'window:1', name: 'VALORANT' }]);
});

test('observer 3 profile scans scoreboard row data', async (t) => {
  let now = 1000;
  const states = [];
  const capture = {
    capture: async () => fakeFrame(now),
    crop: (_frame, roi) => ({ image: Buffer.from(`${roi.x},${roi.y}`) }),
    snapshot: () => ({ frameDataUrl: 'data:image/png;base64,test', crops: {} })
  };
  const ocr = {
    recognize: async (_image, recipe) => {
      const id = recipe.fieldId;
      if (id === 'homeScore') return { text: '0', confidence: 0.99, latencyMs: 1 };
      if (id === 'timer') return { text: '1:20', confidence: 0.99, latencyMs: 1 };
      if (id === 'awayScore') return { text: '1', confidence: 0.99, latencyMs: 1 };
      if (id.includes('playerName')) return { text: 'LCU|ObserverOne', confidence: 0.97, latencyMs: 1 };
      if (id.includes('ultimate')) return { text: '3/8', confidence: 0.96, latencyMs: 1 };
      if (id.includes('kills')) return { text: '4', confidence: 0.96, latencyMs: 1 };
      if (id.includes('deaths')) return { text: '1', confidence: 0.96, latencyMs: 1 };
      if (id.includes('assists')) return { text: '2', confidence: 0.96, latencyMs: 1 };
      if (id.includes('credits')) return { text: '2,600', confidence: 0.96, latencyMs: 1 };
      return { text: '', confidence: 0, latencyMs: 1 };
    }
  };
  const service = new ValorantOcrService({ capture, ocr, onState: (state) => states.push(state), now: () => now });
  t.after(() => service.stop());
  service.settings = normalizeSettings({ enabled: true, profileId: '1920x1080-en-observer3-scoreboard' });
  for (let index = 0; index < 20; index += 1) {
    await service.tick();
    now += 60;
  }
  const player = states.at(-1).observer3.teams.home.players[0];
  assert.equal(player.name, 'ObserverOne');
  assert.equal(player.teamTag, 'LCU');
  assert.equal(player.fullName, 'LCU|ObserverOne');
  assert.equal(player.ultimate, '3/8');
  assert.deepEqual(player.kda, { kills: 4, deaths: 1, assists: 2 });
  assert.deepEqual(player.loadout, { weapon: '', confidence: 0, status: 'pending' });
  assert.equal(player.credits, 2600);
  assert.equal(player.ping, null);
});

test('observer 3 cells retain the last confident reading on weak OCR', async (t) => {
  let weakRead = false;
  const capture = {
    crop: () => ({ image: Buffer.from('test') })
  };
  const ocr = {
    recognize: async () => weakRead
      ? { text: '', confidence: 0.2, latencyMs: 1 }
      : { text: 'ObserverOne', confidence: 0.97, latencyMs: 1 }
  };
  const service = new ValorantOcrService({ capture, ocr });
  t.after(() => service.stop());
  service.settings = normalizeSettings({ enabled: true, profileId: '1920x1080-en-observer3-scoreboard' });
  const profile = getValorantOcrProfile(service.settings.profileId, {
    scoreboardTable: service.settings.scoreboardTableOverrides
  });
  const cell = service.observerCells(profile).find((item) => item.side === 'home' && item.row === 0 && item.columnId === 'playerName');
  await service.scanObserver3Cell(fakeFrame(), profile, cell);
  weakRead = true;
  await service.scanObserver3Cell(fakeFrame(), profile, cell);
  assert.equal(service.observer3.teams.home.players[0].name, 'ObserverOne');
});

test('observer 3 scans names first and locks high-confidence names', async (t) => {
  let now = 1000;
  const scanned = [];
  const capture = {
    crop: () => ({ image: Buffer.from('test') })
  };
  const ocr = {
    recognize: async (_image, recipe) => {
      scanned.push(recipe.fieldId);
      return { text: recipe.fieldId.includes('away-0') ? 'LCU|nyv' : 'Sn0wfal', confidence: 0.97, latencyMs: 1 };
    }
  };
  const service = new ValorantOcrService({ capture, ocr, now: () => now });
  t.after(() => service.stop());
  service.settings = normalizeSettings({ enabled: true, profileId: '1920x1080-en-observer3-scoreboard' });
  const profile = getValorantOcrProfile(service.settings.profileId, {
    scoreboardTable: service.settings.scoreboardTableOverrides
  });
  for (let index = 0; index < Math.ceil(10 / service.settings.observerConcurrency); index += 1) {
    await service.scanObserver3Table(fakeFrame(now), profile, now);
    now += 50;
  }
  assert.equal(scanned.length, 10);
  assert.ok(scanned.every((fieldId) => fieldId.includes('playerName')));
  assert.equal(service.observer3.initialNameScanComplete, true);
  assert.equal(service.observer3.teams.home.players[0].name, 'Sn0wfal');
  assert.equal(service.observer3.teams.home.players[0].nameLocked, true);
  assert.equal(service.observer3.teams.away.players[0].name, 'nyv');
  assert.equal(service.observer3.teams.away.players[0].teamTag, 'LCU');
  assert.equal(service.observer3.teams.away.players[0].nameLocked, true);
});

test('observer 3 normal scan skips locked name cells after startup name pass', async (t) => {
  let now = 1000;
  const scanned = [];
  const capture = {
    crop: () => ({ image: Buffer.from('test') })
  };
  const ocr = {
    recognize: async (_image, recipe) => {
      scanned.push(recipe.fieldId);
      if (recipe.fieldId.includes('playerName')) return { text: 'ObserverOne', confidence: 0.97, latencyMs: 1 };
      if (recipe.fieldId.includes('ultimate')) return { text: '3/8', confidence: 0.97, latencyMs: 1 };
      if (recipe.fieldId.includes('credits')) return { text: '800', confidence: 0.97, latencyMs: 1 };
      return { text: '1', confidence: 0.97, latencyMs: 1 };
    }
  };
  const service = new ValorantOcrService({ capture, ocr, now: () => now });
  t.after(() => service.stop());
  service.settings = normalizeSettings({ enabled: true, profileId: '1920x1080-en-observer3-scoreboard' });
  const profile = getValorantOcrProfile(service.settings.profileId, {
    scoreboardTable: service.settings.scoreboardTableOverrides
  });
  for (let index = 0; index < 10; index += 1) {
    await service.scanObserver3Table(fakeFrame(now), profile, now);
    now += 50;
  }
  scanned.length = 0;
  for (let index = 0; index < 12; index += 1) {
    await service.scanObserver3Table(fakeFrame(now), profile, now);
    now += 50;
  }
  assert.ok(scanned.length > 0);
  assert.ok(scanned.every((fieldId) => !fieldId.includes('playerName')));
});

test('observer 3 skip rule only applies to locked name cells', async (t) => {
  const service = new ValorantOcrService({});
  t.after(() => service.stop());
  service.settings = normalizeSettings({ enabled: true, profileId: '1920x1080-en-observer3-scoreboard' });
  const profile = getValorantOcrProfile(service.settings.profileId, {
    scoreboardTable: service.settings.scoreboardTableOverrides
  });
  service.observer3.teams.home.players[0] = {
    ...service.observer3.teams.home.players[0],
    name: 'LockedName',
    nameLocked: true,
    ultimate: 'READY',
    kda: { kills: 12, deaths: 3, assists: 4 },
    credits: 9000,
    confidence: 1
  };
  const cells = service.observerCells(profile).filter((cell) => cell.side === 'home' && cell.row === 0);
  assert.equal(service.shouldSkipObserverCell(cells.find((cell) => cell.columnId === 'playerName')), true);
  assert.equal(service.shouldSkipObserverCell(cells.find((cell) => cell.columnId === 'ultimate')), false);
  assert.equal(service.shouldSkipObserverCell(cells.find((cell) => cell.columnId === 'kills')), false);
  assert.equal(service.shouldSkipObserverCell(cells.find((cell) => cell.columnId === 'deaths')), false);
  assert.equal(service.shouldSkipObserverCell(cells.find((cell) => cell.columnId === 'assists')), false);
  assert.equal(service.shouldSkipObserverCell(cells.find((cell) => cell.columnId === 'credits')), false);
});

test('observer 3 manual player name locks and skips the name field', async (t) => {
  const service = new ValorantOcrService({});
  t.after(() => service.stop());
  service.settings = normalizeSettings({ enabled: true, profileId: '1920x1080-en-observer3-scoreboard' });
  const profile = getValorantOcrProfile(service.settings.profileId, {
    scoreboardTable: service.settings.scoreboardTableOverrides
  });
  const snapshot = service.setObserverPlayerName({ side: 'away', row: 2, name: 'CorrectName' });
  const player = snapshot.observer3.teams.away.players[2];
  assert.equal(player.name, 'CorrectName');
  assert.equal(player.nameConfidence, 1);
  assert.equal(player.nameLocked, true);
  assert.equal(player.nameManual, true);
  const nameCell = service.observerCells(profile).find((cell) => cell.side === 'away' && cell.row === 2 && cell.columnId === 'playerName');
  const creditsCell = service.observerCells(profile).find((cell) => cell.side === 'away' && cell.row === 2 && cell.columnId === 'credits');
  assert.equal(service.shouldSkipObserverCell(nameCell), true);
  assert.equal(service.shouldSkipObserverCell(creditsCell), false);
});

test('observer 3 credits use numeric crop variants when the icon confuses OCR', async (t) => {
  const capture = {
    crop: (_frame, roi) => ({ image: Buffer.from(`${roi.x},${roi.w}`) })
  };
  const ocr = {
    recognize: async (_image, recipe) => {
      if (recipe.fieldId.endsWith('-v0')) return { text: '', confidence: 0.1, latencyMs: 1 };
      if (recipe.fieldId.endsWith('-v1')) return { text: '2,100', confidence: 0.38, latencyMs: 1 };
      return { text: '', confidence: 0.1, latencyMs: 1 };
    }
  };
  const service = new ValorantOcrService({ capture, ocr });
  t.after(() => service.stop());
  service.settings = normalizeSettings({ enabled: true, profileId: '1920x1080-en-observer3-scoreboard' });
  const profile = getValorantOcrProfile(service.settings.profileId, {
    scoreboardTable: service.settings.scoreboardTableOverrides
  });
  const cell = service.observerCells(profile).find((item) => item.side === 'home' && item.row === 0 && item.columnId === 'credits');
  await service.scanObserver3Cell(fakeFrame(), profile, cell);
  assert.equal(service.observer3.teams.home.players[0].credits, 2100);
  assert.ok(service.observer3.teams.home.players[0].confidence >= 0.78);
});

test('observer 3 credits remove impossible leading icon digits', async (t) => {
  const capture = {
    crop: () => ({ image: Buffer.from('test') })
  };
  const ocr = {
    recognize: async () => ({ text: '35,450', confidence: 0.92, latencyMs: 1 })
  };
  const service = new ValorantOcrService({ capture, ocr });
  t.after(() => service.stop());
  service.settings = normalizeSettings({ enabled: true, profileId: '1920x1080-en-observer3-scoreboard' });
  const profile = getValorantOcrProfile(service.settings.profileId, {
    scoreboardTable: service.settings.scoreboardTableOverrides
  });
  const cell = service.observerCells(profile).find((item) => item.side === 'home' && item.row === 0 && item.columnId === 'credits');
  await service.scanObserver3Cell(fakeFrame(), profile, cell);
  assert.equal(service.observer3.teams.home.players[0].credits, 5450);
});

test('observer 3 credits prefer repeated small-value reads over icon artifacts', async (t) => {
  const capture = {
    crop: () => ({ image: Buffer.from('test') })
  };
  const ocr = {
    recognize: async (_image, recipe) => {
      if (recipe.fieldId.endsWith('-v0')) return { text: '¤ 50', confidence: 0.9, latencyMs: 1 };
      if (recipe.fieldId.endsWith('-v1')) return { text: '250', confidence: 0.96, latencyMs: 1 };
      if (recipe.fieldId.endsWith('-v2')) return { text: '50', confidence: 0.75, latencyMs: 1 };
      return { text: '', confidence: 0.1, latencyMs: 1 };
    }
  };
  const service = new ValorantOcrService({ capture, ocr });
  t.after(() => service.stop());
  service.settings = normalizeSettings({ enabled: true, profileId: '1920x1080-en-observer3-scoreboard' });
  const profile = getValorantOcrProfile(service.settings.profileId, {
    scoreboardTable: service.settings.scoreboardTableOverrides
  });
  const cell = service.observerCells(profile).find((item) => item.side === 'home' && item.row === 0 && item.columnId === 'credits');
  await service.scanObserver3Cell(fakeFrame(), profile, cell);
  assert.equal(service.observer3.teams.home.players[0].credits, 50);
});

test('observer 3 credits treat tiny non-credit artifacts as zero', async (t) => {
  const capture = {
    crop: () => ({ image: Buffer.from('test') })
  };
  const ocr = {
    recognize: async () => ({ text: '20', confidence: 0.96, latencyMs: 1 })
  };
  const service = new ValorantOcrService({ capture, ocr });
  t.after(() => service.stop());
  service.settings = normalizeSettings({ enabled: true, profileId: '1920x1080-en-observer3-scoreboard' });
  const profile = getValorantOcrProfile(service.settings.profileId, {
    scoreboardTable: service.settings.scoreboardTableOverrides
  });
  const cell = service.observerCells(profile).find((item) => item.side === 'home' && item.row === 0 && item.columnId === 'credits');
  await service.scanObserver3Cell(fakeFrame(), profile, cell);
  assert.equal(service.observer3.teams.home.players[0].credits, 0);
});

test('observer 3 player names keep untagged names unchanged', async (t) => {
  const capture = {
    crop: () => ({ image: Buffer.from('test') })
  };
  const ocr = {
    recognize: async () => ({ text: 'santi', confidence: 0.97, latencyMs: 1 })
  };
  const service = new ValorantOcrService({ capture, ocr });
  t.after(() => service.stop());
  service.settings = normalizeSettings({ enabled: true, profileId: '1920x1080-en-observer3-scoreboard' });
  const profile = getValorantOcrProfile(service.settings.profileId, {
    scoreboardTable: service.settings.scoreboardTableOverrides
  });
  const cell = service.observerCells(profile).find((item) => item.side === 'home' && item.row === 0 && item.columnId === 'playerName');
  await service.scanObserver3Cell(fakeFrame(), profile, cell);
  const player = service.observer3.teams.home.players[0];
  assert.equal(player.name, 'santi');
  assert.equal(player.teamTag, '');
  assert.equal(player.fullName, 'santi');
});

test('observer 3 player names keep zeroes and strip team tags from display', async (t) => {
  let text = 'Sn0wfal';
  const capture = {
    crop: () => ({ image: Buffer.from('test') })
  };
  const ocr = {
    recognize: async () => ({ text, confidence: 0.97, latencyMs: 1 })
  };
  const service = new ValorantOcrService({ capture, ocr });
  t.after(() => service.stop());
  service.settings = normalizeSettings({ enabled: true, profileId: '1920x1080-en-observer3-scoreboard' });
  const profile = getValorantOcrProfile(service.settings.profileId, {
    scoreboardTable: service.settings.scoreboardTableOverrides
  });
  const cell = service.observerCells(profile).find((item) => item.side === 'home' && item.row === 0 && item.columnId === 'playerName');
  await service.scanObserver3Cell(fakeFrame(), profile, cell);
  assert.equal(service.observer3.teams.home.players[0].name, 'Sn0wfal');
  text = 'LCU|nyv';
  await service.scanObserver3Cell(fakeFrame(), profile, cell);
  assert.equal(service.observer3.teams.home.players[0].name, 'nyv');
  assert.equal(service.observer3.teams.home.players[0].teamTag, 'LCU');
  text = 'CWTJ';
  await service.scanObserver3Cell(fakeFrame(), profile, cell);
  assert.equal(service.observer3.teams.home.players[0].name, 'CWTJ');
});

test('observer 3 ultimate accepts fractions and READY only when confident', async (t) => {
  let text = '7/8';
  let confidence = 0.97;
  const capture = {
    crop: () => ({ image: Buffer.from('test') })
  };
  const ocr = {
    recognize: async () => ({ text, confidence, latencyMs: 1 })
  };
  const service = new ValorantOcrService({ capture, ocr });
  t.after(() => service.stop());
  service.settings = normalizeSettings({ enabled: true, profileId: '1920x1080-en-observer3-scoreboard' });
  const profile = getValorantOcrProfile(service.settings.profileId, {
    scoreboardTable: service.settings.scoreboardTableOverrides
  });
  const cell = service.observerCells(profile).find((item) => item.side === 'home' && item.row === 0 && item.columnId === 'ultimate');
  await service.scanObserver3Cell(fakeFrame(), profile, cell);
  assert.equal(service.observer3.teams.home.players[0].ultimate, '7/8');
  assert.deepEqual(service.observer3.teams.home.players[0].ultimateState, { status: 'charging', current: 7, required: 8, display: '7/8' });
  text = '';
  confidence = 0.1;
  await service.scanObserver3Cell(fakeFrame(), profile, cell);
  assert.equal(service.observer3.teams.home.players[0].ultimate, '7/8');
  text = 'READY';
  confidence = 0.98;
  await service.scanObserver3Cell(fakeFrame(), profile, cell);
  assert.equal(service.observer3.teams.home.players[0].ultimate, 'READY');
  assert.equal(service.observer3.teams.home.players[0].ultimateState.status, 'ready');
});

test('timer preprocessing variants require agreement before returning full confidence', () => {
  const agreed = chooseOcrConsensus([
    { text: '1:23', confidence: 0.92, latencyMs: 4 },
    { text: '123', confidence: 0.88, latencyMs: 5 },
    { text: '1:28', confidence: 0.97, latencyMs: 6 }
  ], 'timer');
  assert.equal(agreed.text, '1:23');
  assert.equal(agreed.consensus, 2);
  assert.ok(agreed.confidence > 0.8);
  assert.equal(agreed.latencyMs, 15);

  const disputed = chooseOcrConsensus([
    { text: '1:23', confidence: 0.96 },
    { text: '1:24', confidence: 0.94 },
    { text: '1:25', confidence: 0.93 }
  ], 'timer');
  assert.equal(disputed.consensus, 1);
  assert.equal(disputed.confidence, 0.55);
});

test('timer reports spike planted when the timer crop contains the red spike icon', async () => {
  const capture = {
    crop: () => ({ image: Buffer.from('timer') }),
    redRatio: () => 0.09
  };
  const ocr = {
    recognize: async () => ({ text: '', confidence: 0.1, latencyMs: 2 })
  };
  const service = new ValorantOcrService({ capture, ocr });
  const result = await service.recognizeField(fakeFrame(), 'timer', {
    kind: 'timer',
    roi: { x: 900, y: 18, w: 120, h: 64 },
    preprocess: { variants: [{}, {}], allowedChars: '0123456789:' }
  });
  assert.equal(result.state, 'spike-planted');
  assert.equal(result.text, 'SPIKE PLANTED');
  assert.ok(result.confidence >= 0.82);
});

test('capture continues while a slower OCR pass is still running', async (t) => {
  let now = 1000;
  let captures = 0;
  let releaseHome;
  const homeGate = new Promise((resolve) => { releaseHome = resolve; });
  const capture = {
    capture: async () => fakeFrame(++now),
    crop: () => ({ image: Buffer.from('test') })
  };
  const ocr = {
    recognize: async (_image, recipe) => {
      if (recipe.fieldId === 'homeScore') await homeGate;
      return { text: recipe.fieldId === 'timer' ? '1:20' : '0', confidence: 0.99, latencyMs: 2 };
    }
  };
  const service = new ValorantOcrService({
    capture: { ...capture, capture: async (...args) => { captures += 1; return capture.capture(...args); } },
    ocr,
    now: () => now
  });
  t.after(() => service.stop());
  service.settings = normalizeSettings({ enabled: true });
  await service.captureTick();
  const recognition = service.ocrTick();
  await new Promise((resolve) => setImmediate(resolve));
  await service.captureTick();
  assert.equal(captures, 2);
  assert.equal(service.ocrBusy, true);
  releaseHome();
  await recognition;
  assert.equal(service.ocrBusy, false);
});

test('temporary empty captures retain the last good frame and recover automatically', async (t) => {
  let now = 1000;
  let attempt = 0;
  const statuses = [];
  const capture = {
    capture: async () => {
      attempt += 1;
      if (attempt >= 2 && attempt <= 5) throw Object.assign(new Error('Window returned an empty frame'), { code: 'CAPTURE_EMPTY' });
      return fakeFrame(now);
    },
    crop: () => ({ image: Buffer.from('test') })
  };
  const ocr = { recognize: async ({}) => ({ text: '0', confidence: 0.99, latencyMs: 1 }) };
  const service = new ValorantOcrService({ capture, ocr, onStatus: (status) => statuses.push(status), now: () => now });
  t.after(() => service.stop());
  service.settings = normalizeSettings({ enabled: true });
  await service.tick();
  const lastGoodFrame = service.latestFrame;
  now += 250;
  await service.tick();
  assert.equal(service.latestFrame, lastGoodFrame);
  assert.equal(statuses.at(-1).state, 'recovering');
  assert.equal(statuses.at(-1).usingLastGoodFrame, true);
  assert.equal(statuses.at(-1).consecutiveCaptureFailures, 1);
  for (let index = 0; index < 3; index += 1) {
    now += 250;
    await service.tick();
  }
  assert.equal(service.status.state, 'degraded');
  assert.equal(service.latestFrame, lastGoodFrame);
  assert.equal(service.status.consecutiveCaptureFailures, 4);
  now += 250;
  await service.tick();
  assert.notEqual(service.status.state, 'recovering');
  assert.equal(service.status.consecutiveCaptureFailures, 0);
  assert.equal(service.status.captureFailures, 4);
  assert.equal(service.status.lastCaptureRecoveredAt, now);
});

test('capture failures provide actionable status', async (t) => {
  const statuses = [];
  const error = Object.assign(new Error('Window containing “VALORANT” was not found'), { code: 'WINDOW_NOT_FOUND' });
  const service = new ValorantOcrService({
    capture: { capture: async () => { throw error; } },
    ocr: {},
    onStatus: (status) => statuses.push(status)
  });
  t.after(() => service.stop());
  service.settings = normalizeSettings({ enabled: true });
  await service.tick();
  assert.equal(statuses.at(-1).state, 'searching-window');
});

test('simulator immediately emits stable test data', (t) => {
  const states = [];
  const service = new ValorantOcrService({ onState: (state) => states.push(state) });
  t.after(() => service.stop());
  service.startSimulator();
  assert.equal(service.status.state, 'simulating');
  assert.equal(states.at(-1).fields.timer.value, 100);
  assert.equal(states.at(-1).fields.homeScore.value, 0);
});

test('remote receiver accepts current universal bridge state and rejects old sequences', async (t) => {
  const port = await reservePort();
  const states = [];
  let listening;
  const ready = new Promise((resolve) => { listening = resolve; });
  const service = new ValorantOcrService({
    onState: (state) => states.push(state),
    onStatus: (status) => { if (status.state === 'listening') listening(); }
  });
  t.after(() => service.stop());
  service.configure({ enabled: true, source: 'remote', bridgePort: port, bridgeToken: 'valorant-test-key' });
  await ready;
  const socket = new WebSocket(`ws://127.0.0.1:${port}/game-bridge?game=valorant&token=valorant-test-key`);
  t.after(() => socket.close());
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  const state = {
    source: 'valorant-ocr', connected: true,
    capture: { width: 1920, height: 1080, fps: 8 },
    match: { timerSeconds: 73, timerDisplay: '1:13' },
    teams: { home: { score: 3 }, away: { score: 2 } },
    fields: {
      homeScore: { value: 3, updatedAt: Date.now(), stale: false },
      timer: { value: 73, updatedAt: Date.now(), stale: false },
      awayScore: { value: 2, updatedAt: Date.now(), stale: false }
    },
    metrics: { observations: 20, accepted: 18, rejected: 2 }
  };
  socket.send(JSON.stringify({ type: 'game-state', game: 'valorant', version: 1, sequence: 2, payload: state }));
  socket.send(JSON.stringify({ type: 'game-state', game: 'valorant', version: 1, sequence: 1, payload: { ...state, teams: { home: { score: 0 }, away: { score: 0 } } } }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(states.at(-1).teams.home.score, 3);
  assert.equal(states.at(-1).match.timerSeconds, 73);
  assert.equal(service.status.state, 'reading');
  service.clearState();
  assert.equal(states.at(-1).teams.home.score, null);
});
