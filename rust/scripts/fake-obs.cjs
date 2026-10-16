// The fake obs-websocket 5 server from test/obs-displays.test.cjs, as a process, so the Rust OBS
// client is tested against the same fake as the JS one. Prints "PORT <n>", then on stdin "dump"
// prints the fake OBS state as JSON.   node rust/scripts/fake-obs.cjs [password] [ndiInstalled 1|0]
const path = require('node:path'); const repo = path.join(__dirname, '..', '..');
const src = require('node:fs').readFileSync(path.join(repo, 'test/obs-displays.test.cjs'), 'utf8');
const { WebSocketServer } = require('ws');
const { authString, ALL_SCENE } = require(path.join(repo, 'electron/displays/obs-displays.cjs'));
const fakeObs = eval(`(${src.match(/function fakeObs\([\s\S]*?\n\}/)[0]})`);
(async () => {
  const f = await fakeObs({ password: process.argv[2] || 'pw', ndiInstalled: process.argv[3] !== '0' });
  console.log('PORT', f.port);
  process.stdin.on('data', (d) => {
    if (String(d).includes('dump')) {
      const o = f.obs; const scenes = {}; for (const [k, v] of o.scenes) scenes[k] = { items: v.items, filters: Object.fromEntries([...v.filters].map(([n, x]) => [n, x])) };
      console.log('DUMP', JSON.stringify({ scenes, inputs: Object.fromEntries(o.inputs), video: o.video, program: o.program }));
    }
  });
})();
