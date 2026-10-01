import type { SomeCompanionConfigField } from '@companion-module/base'

export type ModuleConfig = { host: string; port: number }
export type ModuleSecrets = { token: string }

export function GetConfigFields(): SomeCompanionConfigField[] {
	return [
		{
			type: 'textinput',
			id: 'host',
			label: 'Stream Server IP / hostname',
			width: 6,
			default: '127.0.0.1',
			tooltip:
				'Use 127.0.0.1 when Companion runs on the Director PC. For another PC, tick "Allow other PCs" in Stream Server.',
		},
		{ type: 'number', id: 'port', label: 'API port', width: 3, min: 1024, max: 65535, default: 3180 },
		{
			type: 'secret-text',
			id: 'token',
			label: 'Stream Server API key',
			width: 9,
			default: '',
			minLength: 16,
			tooltip: 'Stream Server → 06 / Companion API → Show / copy key. This is NOT the Broadcast Control key.',
		},
	]
}

export function normalizeConfig(
	config: Partial<ModuleConfig>,
	secrets: Partial<ModuleSecrets>,
): { config: ModuleConfig; secrets: ModuleSecrets } {
	return {
		config: {
			host: String(config?.host ?? '127.0.0.1').trim(),
			port: config?.port === undefined ? 3180 : Number(config.port),
		},
		secrets: { token: String(secrets?.token ?? '').trim() },
	}
}

export function getConfigError(config: ModuleConfig, secrets: ModuleSecrets): string | undefined {
	if (!config.host) return 'Stream Server IP / hostname is empty'
	if (config.host.includes('://') || config.host.includes('/'))
		return 'Enter only the IP or hostname, without http:// or a path'
	if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535)
		return 'API port must be a whole number from 1024 to 65535'
	if (!secrets.token) return 'API key is empty; copy it from Stream Server → Companion API'
	if (secrets.token.length < 16) return 'API key is too short; copy the complete key'
	return undefined
}
