import type { ModuleConfig, ModuleSecrets } from './config.js'

export type BroadcastVariableValue = string | number | boolean
export type BroadcastVariables = Record<string, BroadcastVariableValue>
export type ControlAction = Record<string, unknown> & { action: string }

export type ApiClientCallbacks = {
	onConnecting: () => void
	onConnected: () => void
	onDisconnected: (message: string) => void
	onVariables: (variables: BroadcastVariables) => void
}

function cleanVariables(value: unknown): BroadcastVariables {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
	return Object.fromEntries(
		Object.entries(value).filter((entry): entry is [string, BroadcastVariableValue] =>
			['string', 'number', 'boolean'].includes(typeof entry[1]),
		),
	)
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

export class BroadcastControlClient {
	private active = false
	private streamAbort?: AbortController
	private reconnectTimer?: NodeJS.Timeout
	private generation = 0

	constructor(
		private readonly config: ModuleConfig,
		private readonly secrets: ModuleSecrets,
		private readonly callbacks: ApiClientCallbacks,
	) {}

	private get baseUrl(): string {
		const host = this.config.host
			.trim()
			.replace(/^https?:\/\//i, '')
			.replace(/\/+$/, '')
		return `http://${host}:${Number(this.config.port)}/api/companion`
	}

	start(): void {
		this.stop()
		this.active = true
		const generation = ++this.generation
		void this.openEventStream(generation)
	}

	stop(): void {
		this.active = false
		this.generation += 1
		this.streamAbort?.abort()
		this.streamAbort = undefined
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
		this.reconnectTimer = undefined
	}

	async sendAction(action: ControlAction): Promise<string> {
		const abort = new AbortController()
		const timeout = setTimeout(() => abort.abort(), 5000)
		try {
			const response = await fetch(`${this.baseUrl}/action`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'X-ISU-API-Key': this.secrets.token.trim(),
				},
				body: JSON.stringify(action),
				signal: abort.signal,
			})
			const result = (await response.json().catch(() => ({}))) as Record<string, unknown>
			if (!response.ok)
				throw new Error(typeof result.error === 'string' ? result.error : `Controller returned HTTP ${response.status}`)
			const variables = cleanVariables(result.variables)
			if (Object.keys(variables).length) this.callbacks.onVariables(variables)
			this.callbacks.onConnected()
			return typeof result.message === 'string' ? result.message : 'Action applied'
		} finally {
			clearTimeout(timeout)
		}
	}

	private scheduleReconnect(generation: number): void {
		if (!this.active || generation !== this.generation) return
		this.reconnectTimer = setTimeout(() => void this.openEventStream(generation), 2000)
	}

	private async openEventStream(generation: number): Promise<void> {
		if (!this.active || generation !== this.generation) return
		this.callbacks.onConnecting()
		const abort = new AbortController()
		this.streamAbort = abort
		try {
			const response = await fetch(`${this.baseUrl}/events`, {
				headers: {
					Accept: 'text/event-stream',
					'X-ISU-API-Key': this.secrets.token.trim(),
				},
				signal: abort.signal,
			})
			if (!response.ok) {
				const result = (await response.json().catch(() => ({}))) as Record<string, unknown>
				throw new Error(typeof result.error === 'string' ? result.error : `Controller returned HTTP ${response.status}`)
			}
			if (!response.body) throw new Error('Controller returned an empty event stream')
			this.callbacks.onConnected()
			const reader = response.body.getReader()
			const decoder = new TextDecoder()
			let buffer = ''
			while (this.active && generation === this.generation) {
				const { done, value } = await reader.read()
				if (done) break
				buffer += decoder.decode(value, { stream: true })
				const frames = buffer.split(/\r?\n\r?\n/)
				buffer = frames.pop() || ''
				for (const frame of frames) this.handleEventFrame(frame)
			}
			reader.releaseLock()
			if (this.active && generation === this.generation) throw new Error('Controller event stream closed')
		} catch (error) {
			if (!this.active || generation !== this.generation) return
			this.callbacks.onDisconnected(errorMessage(error))
		} finally {
			if (this.streamAbort === abort) this.streamAbort = undefined
		}
		this.scheduleReconnect(generation)
	}

	private handleEventFrame(frame: string): void {
		const data = frame
			.split(/\r?\n/)
			.filter((line) => line.startsWith('data:'))
			.map((line) => line.slice(5).trimStart())
			.join('\n')
		if (!data) return
		try {
			const variables = cleanVariables(JSON.parse(data))
			if (Object.keys(variables).length) this.callbacks.onVariables(variables)
		} catch {
			// Ignore a malformed event and keep the live connection open.
		}
	}
}
