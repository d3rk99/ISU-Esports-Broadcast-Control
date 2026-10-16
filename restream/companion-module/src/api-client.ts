import type { ModuleConfig, ModuleSecrets } from './config.js'

export type RestreamValue = string | number | boolean
export type RestreamVariables = Record<string, RestreamValue>

export type ClientCallbacks = {
	onConnected: () => void
	onDisconnected: (message: string) => void
	onVariables: (variables: RestreamVariables) => void
}

// Restream's /api/state is one flat JSON object; nulls become '' (Companion variables can't be null).
export function clean(value: unknown): RestreamVariables {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
	const out: RestreamVariables = {}
	for (const [k, v] of Object.entries(value)) {
		if (v === null) out[k] = ''
		else if (['string', 'number', 'boolean'].includes(typeof v)) out[k] = v as RestreamValue
	}
	return out
}

export class RestreamClient {
	private timer?: NodeJS.Timeout
	private active = false
	private connected = false
	private generation = 0

	constructor(
		private readonly config: ModuleConfig,
		private readonly secrets: ModuleSecrets,
		private readonly callbacks: ClientCallbacks,
	) {}

	private url(path: string): string {
		return `http://${this.config.host}:${this.config.port}${path}`
	}

	private async request(method: 'GET' | 'POST', path: string): Promise<Record<string, unknown>> {
		const abort = new AbortController()
		const timeout = setTimeout(() => abort.abort(), method === 'GET' ? 3000 : 12000)
		try {
			const response = await fetch(this.url(path), { method, headers: { 'X-Restream-Key': this.secrets.key }, signal: abort.signal })
			const result = (await response.json().catch(() => ({}))) as Record<string, unknown>
			if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : `Restream returned HTTP ${response.status}`)
			return result
		} catch (error) {
			if (error instanceof Error && error.name === 'AbortError') throw new Error('Restream did not answer')
			throw error
		} finally {
			clearTimeout(timeout)
		}
	}

	start(): void {
		this.stop()
		this.active = true
		void this.poll(++this.generation)
	}

	stop(): void {
		this.active = false
		this.generation += 1
		if (this.timer) clearTimeout(this.timer)
		this.timer = undefined
	}

	private async poll(generation: number): Promise<void> {
		if (!this.active || generation !== this.generation) return
		try {
			const state = await this.request('GET', '/api/state')
			if (!this.active || generation !== this.generation) return
			if (!this.connected) {
				this.connected = true
				this.callbacks.onConnected()
			}
			this.callbacks.onVariables(clean(state))
		} catch (error) {
			if (!this.active || generation !== this.generation) return
			this.connected = false
			this.callbacks.onDisconnected(error instanceof Error ? error.message : String(error))
		}
		if (this.active && generation === this.generation) this.timer = setTimeout(() => void this.poll(generation), this.config.poll_ms)
	}

	// POST a command; returns Restream's message, throws its reason ("not live", ...).
	async command(path: string): Promise<string> {
		const result = await this.request('POST', path)
		if (result.state && typeof result.state === 'object') this.callbacks.onVariables(clean(result.state))
		return typeof result.message === 'string' ? result.message : 'Done'
	}
}
