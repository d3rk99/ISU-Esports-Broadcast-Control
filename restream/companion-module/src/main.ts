import { InstanceBase, InstanceStatus, type SomeCompanionConfigField } from '@companion-module/base'
import { RestreamClient, type RestreamVariables } from './api-client.js'
import { UpdateActions, type ActionsSchema } from './actions.js'
import { GetConfigFields, getConfigError, normalizeConfig, type ModuleConfig, type ModuleSecrets } from './config.js'
import { FEEDBACK_VARIABLES, UpdateFeedbacks, type FeedbacksSchema } from './feedbacks.js'
import { UpdatePresets } from './presets.js'
import { UpgradeScripts } from './upgrades.js'
import { emptyVariables, UpdateVariableDefinitions, type VariablesSchema } from './variables.js'

export type ModuleSchema = {
	config: ModuleConfig
	secrets: ModuleSecrets
	actions: ActionsSchema
	feedbacks: FeedbacksSchema
	variables: VariablesSchema
}

export { UpgradeScripts }

export default class ModuleInstance extends InstanceBase<ModuleSchema> {
	config!: ModuleConfig
	secrets!: ModuleSecrets
	private client?: RestreamClient
	private values: RestreamVariables = emptyVariables()

	constructor(internal: unknown) {
		super(internal)
	}

	async init(config: ModuleConfig, _isFirstInit: boolean, secrets: ModuleSecrets): Promise<void> {
		;({ config: this.config, secrets: this.secrets } = normalizeConfig(config, secrets))
		UpdateActions(this)
		UpdateFeedbacks(this)
		UpdatePresets(this)
		UpdateVariableDefinitions(this)
		this.connect()
	}

	async destroy(): Promise<void> {
		this.client?.stop()
		this.client = undefined
	}

	async configUpdated(config: ModuleConfig, secrets: ModuleSecrets): Promise<void> {
		;({ config: this.config, secrets: this.secrets } = normalizeConfig(config, { key: secrets?.key || this.secrets?.key }))
		this.connect()
	}

	getConfigFields(): SomeCompanionConfigField[] {
		return GetConfigFields()
	}

	getVariableValue(id: string): string | number | boolean | undefined {
		return this.values[id]
	}

	async command(path: string): Promise<void> {
		if (!this.client) throw new Error('Restream connection is not configured')
		try {
			this.log('info', `Restream: ${await this.client.command(path)}`)
		} catch (error) {
			// A refused command ("not live", "already live") is not a connection failure: just log why.
			this.log('warn', `Restream: ${error instanceof Error ? error.message : String(error)}`)
			throw error
		}
	}

	private connect(): void {
		this.client?.stop()
		this.client = undefined
		this.apply({ ...emptyVariables(), connection_ok: false })
		const problem = getConfigError(this.config, this.secrets)
		if (problem) {
			this.updateStatus(InstanceStatus.BadConfig, problem)
			return
		}
		this.updateStatus(InstanceStatus.Connecting)
		this.client = new RestreamClient(this.config, this.secrets, {
			onConnected: () => this.updateStatus(InstanceStatus.Ok),
			onDisconnected: (message) => {
				this.updateStatus(InstanceStatus.ConnectionFailure, message)
				// Never show a stale ON AIR while disconnected.
				this.apply({ ...emptyVariables(), connection_ok: false })
			},
			onVariables: (v) => this.apply({ ...v, connection_ok: true }),
		})
		this.client.start()
	}

	private apply(next: RestreamVariables): void {
		const changed = Object.fromEntries(Object.entries(next).filter(([id, value]) => this.values[id] !== value))
		if (!Object.keys(changed).length) return
		this.values = { ...this.values, ...changed }
		this.setVariableValues(changed)
		const ids = (Object.keys(FEEDBACK_VARIABLES) as (keyof FeedbacksSchema)[]).filter((f) =>
			FEEDBACK_VARIABLES[f].some((id) => Object.hasOwn(changed, id)),
		)
		const [first, ...rest] = ids
		if (first) this.checkFeedbacks(first, ...rest)
	}
}
