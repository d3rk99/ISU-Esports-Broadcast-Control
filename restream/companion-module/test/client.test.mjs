// Runs the module's real RestreamClient against Restream's real control server
// (cargo test -p restream-gui -- --ignored serve_for_module_test, port 39182).
import test from 'node:test'
import assert from 'node:assert/strict'
import { RestreamClient, clean } from '../dist/api-client.js'

test('clean: nulls become empty strings, objects dropped', () => {
	assert.deepEqual(clean({ a: 1, b: null, c: 'x', d: { z: 1 }, e: true }), { a: 1, b: '', c: 'x', e: true })
})

test('client: state, command, refused command, wrong key', { skip: !process.env.RESTREAM_E2E }, async () => {
	const seen = []
	let connected = false
	const c = new RestreamClient({ host: '127.0.0.1', port: 39182, poll_ms: 250 }, { key: 'k'.repeat(32) }, {
		onConnected: () => (connected = true),
		onDisconnected: (m) => seen.push(['down', m]),
		onVariables: (v) => seen.push(v),
	})
	c.start()
	await new Promise((r) => setTimeout(r, 700))
	assert.ok(connected)
	const v = seen.find((x) => x.state)
	assert.equal(v.state, 'ON AIR'); assert.equal(v.on_air, true); assert.equal(v.out1_name, 'ISU Twitch'); assert.equal(v.out1_live, true)
	assert.equal(v.audio_peak_r, '')
	assert.equal(await c.command('/api/gain/adjust?db=2'), 'gain 2.0 dB')
	await assert.rejects(c.command('/api/go-live'), /already live/)
	c.stop()
	const bad = new RestreamClient({ host: '127.0.0.1', port: 39182, poll_ms: 250 }, { key: 'x'.repeat(32) }, {
		onConnected: () => assert.fail('must not connect'), onDisconnected: (m) => seen.push(['bad', m]), onVariables: () => {},
	})
	bad.start(); await new Promise((r) => setTimeout(r, 400)); bad.stop()
	assert.ok(seen.some((x) => x[0] === 'bad' && /X-Restream-Key/.test(x[1])))
})
