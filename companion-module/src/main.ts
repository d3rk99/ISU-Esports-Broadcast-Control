import { InstanceBase, InstanceStatus, type SomeCompanionConfigField } from '@companion-module/base'
import { BroadcastControlClient, type BroadcastVariables, type ControlAction } from './api-client.js'
import { UpdateActions, type ActionsSchema } from './actions.js'
import {
	GetConfigFields,
	getConfigError,
	isValidConfig,
	normalizeConnectionConfig,
	type ModuleConfig,
	type ModuleSecrets,
} from './config.js'
import { UpdateFeedbacks, type FeedbacksSchema } from './feedbacks.js'
import { UpdatePresets } from './presets.js'
import { UpgradeScripts } from './upgrades.js'
import { emptyVariableValues, UpdateVariableDefinitions, type VariablesSchema } from './variables.js'

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
	private client?: BroadcastControlClient
	private variableValues: BroadcastVariables = emptyVariableValues()

	constructor(internal: unknown) {
		super(internal)
	}

	async init(config: ModuleConfig, _isFirstInit: boolean, secrets: ModuleSecrets): Promise<void> {
		const normalized = normalizeConnectionConfig(config, secrets)
		this.config = normalized.config
		this.secrets = normalized.secrets
		this.updateActions()
		this.updateFeedbacks()
		this.updatePresets()
		this.updateVariableDefinitions()
		this.setVariableValues({ ...this.variableValues, connection_ok: false })
		this.startConnection()
	}

	async destroy(): Promise<void> {
		this.client?.stop()
		this.client = undefined
		this.log('debug', 'ISU Esports Broadcast Control connection destroyed')
	}

	async configUpdated(config: ModuleConfig, secrets: ModuleSecrets): Promise<void> {
		const normalized = normalizeConnectionConfig(config, secrets, this.secrets)
		this.config = normalized.config
		this.secrets = normalized.secrets
		this.startConnection()
	}

	getConfigFields(): SomeCompanionConfigField[] {
		return GetConfigFields()
	}

	getVariableValue(id: string): string | number | boolean | undefined {
		return this.variableValues[id]
	}

	async sendControlAction(action: ControlAction): Promise<void> {
		if (!this.client || !isValidConfig(this.config, this.secrets))
			throw new Error('Controller connection is not configured')
		try {
			const message = await this.client.sendAction(action)
			this.log('debug', message)
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			this.updateStatus(InstanceStatus.ConnectionFailure, message)
			this.log('error', `Controller action failed: ${message}`)
			throw error
		}
	}

	private startConnection(): void {
		this.client?.stop()
		this.client = undefined
		this.handleConnectionState(false)
		const configError = getConfigError(this.config, this.secrets)
		if (configError) {
			this.updateStatus(InstanceStatus.BadConfig, configError)
			this.log('warn', `Connection configuration is incomplete: ${configError}`)
			return
		}

		this.client = new BroadcastControlClient(this.config, this.secrets, {
			onConnecting: () => this.updateStatus(InstanceStatus.Connecting, 'Connecting to Broadcast Control'),
			onConnected: () => {
				this.updateStatus(InstanceStatus.Ok)
				this.handleConnectionState(true)
			},
			onDisconnected: (message) => {
				this.handleConnectionState(false)
				this.updateStatus(InstanceStatus.ConnectionFailure, message)
			},
			onVariables: (variables) => this.handleVariables(variables),
		})
		this.client.start()
	}

	private handleConnectionState(connected: boolean): void {
		this.variableValues.connection_ok = connected
		this.setVariableValues({ connection_ok: connected })
		this.checkFeedbacks('controller_connected')
	}

	private handleVariables(variables: BroadcastVariables): void {
		const changed = Object.fromEntries(
			Object.entries(variables).filter(([id, value]) => this.variableValues[id] !== value),
		)
		this.variableValues = { ...this.variableValues, ...changed, connection_ok: true }
		if (!Object.keys(changed).length) return
		this.setVariableValues(changed)
		if (Object.hasOwn(changed, 'live')) this.checkFeedbacks('is_live')
		if (Object.hasOwn(changed, 'selected_game')) this.checkFeedbacks('selected_game')
		if (
			['home_score', 'away_score', 'home_detail_score', 'away_detail_score'].some((id) => Object.hasOwn(changed, id))
		) {
			this.checkFeedbacks('team_leading')
		}
	}

	private updateActions(): void {
		UpdateActions(this)
	}

	private updateFeedbacks(): void {
		UpdateFeedbacks(this)
	}

	private updatePresets(): void {
		UpdatePresets(this)
	}

	private updateVariableDefinitions(): void {
		UpdateVariableDefinitions(this)
	}
}
