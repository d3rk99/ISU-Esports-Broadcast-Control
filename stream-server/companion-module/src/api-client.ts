import type { ModuleConfig, ModuleSecrets } from './config.js'

export type StreamValue = string | number | boolean
export type StreamVariables = Record<string, StreamValue>

export type ClientCallbacks = {
	onConnecting: () => void
	onConnected: () => void
	onDisconnected: (message: string) => void
	onVariables: (variables: StreamVariables) => void
}

function clean(value: unknown): StreamVariables {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
	return Object.fromEntries(
		Object.entries(value).filter((e): e is [string, StreamValue] =>
			['string', 'number', 'boolean'].includes(typeof e[1]),
		),
	)
}

export class StreamServerClient {
	private active = false
	private abort?: AbortController
	private timer?: NodeJS.Timeout
	private generation = 0

	constructor(
		private readonly config: ModuleConfig,
		private readonly secrets: ModuleSecrets,
		private readonly callbacks: ClientCallbacks,
	) {}

	private url(path: string): string {
		return `http://${this.config.host}:${this.config.port}${path}`
	}

	start(): void {
		this.stop()
		this.active = true
		void this.listen(++this.generation)
	}

	stop(): void {
		this.active = false
		this.generation += 1
		this.abort?.abort()
		this.abort = undefined
		if (this.timer) clearTimeout(this.timer)
		this.timer = undefined
	}

	// POST a command. Throws with the server's reason (e.g. "Outputs locked: ...").
	async post(path: string, body?: Record<string, unknown>): Promise<string> {
		const abort = new AbortController()
		const timeout = setTimeout(() => abort.abort(), 8000)
		try {
			const response = await fetch(this.url(path), {
				method: 'POST',
				headers: { 'X-ISU-Stream-Key': this.secrets.token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
				body: body ? JSON.stringify(body) : undefined,
				signal: abort.signal,
			})
			const result = (await response.json().catch(() => ({}))) as Record<string, unknown>
			const variables = clean(result.variables)
			if (Object.keys(variables).length) this.callbacks.onVariables(variables)
			if (!response.ok)
				throw new Error(
					typeof result.error === 'string' ? result.error : `Stream Server returned HTTP ${response.status}`,
				)
			return typeof result.message === 'string' ? result.message : 'Done'
		} finally {
			clearTimeout(timeout)
		}
	}

	private async listen(generation: number): Promise<void> {
		if (!this.active || generation !== this.generation) return
		this.callbacks.onConnecting()
		const abort = new AbortController()
		this.abort = abort
		try {
			const response = await fetch(this.url('/api/events'), {
				headers: { Accept: 'text/event-stream', 'X-ISU-Stream-Key': this.secrets.token },
				signal: abort.signal,
			})
			if (!response.ok) {
				const result = (await response.json().catch(() => ({}))) as Record<string, unknown>
				throw new Error(
					typeof result.error === 'string' ? result.error : `Stream Server returned HTTP ${response.status}`,
				)
			}
			if (!response.body) throw new Error('Empty event stream')
			this.callbacks.onConnected()
			const reader = response.body.getReader()
			const decoder = new TextDecoder()
			let buffer = ''
			// The server sends a copy at least every 15 s; silence for 40 s means a dead link.
			let watchdog = setTimeout(() => abort.abort(), 40000)
			while (this.active && generation === this.generation) {
				const { done, value } = await reader.read()
				if (done) break
				clearTimeout(watchdog)
				watchdog = setTimeout(() => abort.abort(), 40000)
				buffer += decoder.decode(value, { stream: true })
				const frames = buffer.split(/\r?\n\r?\n/)
				buffer = frames.pop() || ''
				for (const frame of frames) {
					const data = frame
						.split(/\r?\n/)
						.filter((l) => l.startsWith('data:'))
						.map((l) => l.slice(5).trimStart())
						.join('\n')
					if (!data) continue
					try {
						this.callbacks.onVariables(clean(JSON.parse(data)))
					} catch {
						// ignore a malformed frame
					}
				}
			}
			clearTimeout(watchdog)
			if (this.active && generation === this.generation) throw new Error('Stream Server event stream closed')
		} catch (error) {
			if (!this.active || generation !== this.generation) return
			this.callbacks.onDisconnected(
				error instanceof Error
					? error.name === 'AbortError'
						? 'Stream Server stopped responding'
						: error.message
					: String(error),
			)
		} finally {
			if (this.abort === abort) this.abort = undefined
		}
		if (this.active && generation === this.generation) this.timer = setTimeout(() => void this.listen(generation), 2000)
	}
}
