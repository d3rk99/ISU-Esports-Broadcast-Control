import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
// eslint-disable-next-line n/no-unpublished-import
import { StreamServerClient } from '../dist/api-client.js'
// eslint-disable-next-line n/no-unpublished-import
import { getConfigError } from '../dist/config.js'
// eslint-disable-next-line n/no-unpublished-import
import { variableDefinitions } from '../dist/variables.js'

const require = createRequire(import.meta.url)
const { ApiServer, companionVariables } = require('../../core/api.cjs')
const KEY = 'stream-key-0123456789abcdef'

// Talks to the REAL Stream Server ApiServer (fake engine status underneath).
async function server(t, locked = true) {
	const status = {
		engine: 'RUNNING',
		encoder: 'ENCODING',
		telemetry: { fps: 60 },
		buffer: { ready: !locked, filledSeconds: locked ? 60 : 300, configuredSeconds: 300 },
		outputsLocked: locked,
		programHealth: { healthy: !locked, problems: locked ? ['BUFFERING'] : [] },
		recording: { state: 'STOPPED' },
		outputs: [{ id: 'o1', name: 'Twitch', state: 'STOPPED', health: 'OFF' }],
	}
	const calls = []
	const api = new ApiServer({
		getKey: () => KEY,
		getStatus: () => status,
		run: async (a, p) => {
			calls.push([a, p])
			if (status.outputsLocked && a === 'startAll') throw new Error('Outputs locked: the delay buffer has not filled')
			if (a === 'startAll')
				Object.assign(status.outputs[0], { state: 'CONNECTED', live: true, healthy: true, health: 'HEALTHY' })
		},
	})
	await api.start({ port: 0, lan: false })
	t.after(() => api.stop())
	return { port: api.server.address().port, calls, status }
}

test('every variable the server sends has a Companion definition', () => {
	const defs = variableDefinitions()
	const sent = Object.keys(companionVariables({ outputs: [] }))
	assert.deepEqual(
		sent.filter((id) => !defs[id]),
		[],
	)
})

test('client receives live variables and reports a locked start with the reason', async (t) => {
	const { port, calls } = await server(t, true)
	const seen = []
	let connected = false
	const client = new StreamServerClient(
		{ host: '127.0.0.1', port },
		{ token: KEY },
		{
			onConnecting() {},
			onConnected: () => (connected = true),
			onDisconnected() {},
			onVariables: (v) => seen.push(v),
		},
	)
	client.start()
	t.after(() => client.stop())
	for (let i = 0; i < 50 && !seen.length; i++) await new Promise((r) => setTimeout(r, 20))
	assert.ok(connected)
	assert.equal(seen[0].delay_percent, 20)
	assert.equal(seen[0].out1_name, 'Twitch')
	await assert.rejects(client.post('/api/stream/start'), /locked/)
	assert.deepEqual(calls[0], ['startAll', {}])
})

test('wrong key is reported as a disconnect, not silently accepted', async (t) => {
	const { port } = await server(t)
	let message = ''
	const client = new StreamServerClient(
		{ host: '127.0.0.1', port },
		{ token: 'x'.repeat(20) },
		{
			onConnecting() {},
			onConnected() {},
			onDisconnected: (m) => (message = m),
			onVariables() {},
		},
	)
	client.start()
	t.after(() => client.stop())
	for (let i = 0; i < 50 && !message; i++) await new Promise((r) => setTimeout(r, 20))
	assert.match(message, /X-ISU-Stream-Key/)
})

test('config errors are specific', () => {
	assert.match(getConfigError({ host: 'http://1.2.3.4', port: 3180 }, { token: KEY }) ?? '', /without http/)
	assert.match(getConfigError({ host: '1.2.3.4', port: 3180 }, { token: '' }) ?? '', /empty/)
	assert.equal(getConfigError({ host: '1.2.3.4', port: 3180 }, { token: KEY }), undefined)
})
