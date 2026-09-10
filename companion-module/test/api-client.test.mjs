import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
// eslint-disable-next-line n/no-unpublished-import
import { BroadcastControlClient } from '../dist/api-client.js'

function startMockController() {
	let receivedAction
	const server = http.createServer((request, response) => {
		if (request.headers['x-isu-api-key'] !== 'test-private-key') {
			response.writeHead(401, { 'Content-Type': 'application/json' })
			response.end(JSON.stringify({ error: 'Unauthorized' }))
			return
		}
		if (request.url === '/api/companion/events') {
			response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' })
			response.write('event: variables\ndata: {"selected_game":"valorant","home_score":1}\n\n')
			return
		}
		if (request.url === '/api/companion/action' && request.method === 'POST') {
			let body = ''
			request.setEncoding('utf8')
			request.on('data', (chunk) => (body += chunk))
			request.on('end', () => {
				receivedAction = JSON.parse(body)
				response.writeHead(200, { 'Content-Type': 'application/json' })
				response.end(JSON.stringify({ ok: true, message: 'Score changed', variables: { home_score: 2 } }))
			})
			return
		}
		response.writeHead(404)
		response.end()
	})
	return {
		server,
		get receivedAction() {
			return receivedAction
		},
	}
}

test('client receives SSE variables and sends authenticated actions', async (t) => {
	const mock = startMockController()
	await new Promise((resolve) => mock.server.listen(0, '127.0.0.1', resolve))
	const port = mock.server.address().port
	const variableEvents = []
	let resolveFirstVariables
	const firstVariables = new Promise((resolve) => (resolveFirstVariables = resolve))
	const client = new BroadcastControlClient(
		{ host: '127.0.0.1', port },
		{ token: 'test-private-key' },
		{
			onConnecting: () => {},
			onConnected: () => {},
			onDisconnected: () => {},
			onVariables: (variables) => {
				variableEvents.push(variables)
				resolveFirstVariables()
			},
		},
	)
	t.after(async () => {
		client.stop()
		mock.server.closeAllConnections()
		await new Promise((resolve) => mock.server.close(resolve))
	})

	client.start()
	await Promise.race([
		firstVariables,
		new Promise((_, reject) => setTimeout(() => reject(new Error('SSE variables timed out')), 2000)),
	])
	assert.equal(variableEvents[0].selected_game, 'valorant')
	assert.equal(variableEvents[0].home_score, 1)

	const message = await client.sendAction({ action: 'score.increment', team: 'home' })
	assert.equal(message, 'Score changed')
	assert.deepEqual(mock.receivedAction, { action: 'score.increment', team: 'home' })
	assert.equal(variableEvents.at(-1).home_score, 2)
})
