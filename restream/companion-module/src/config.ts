import type { SomeCompanionConfigField } from '@companion-module/base'

export type ModuleConfig = { host: string; port: number; poll_ms: number }
export type ModuleSecrets = { key: string }

export function GetConfigFields(): SomeCompanionConfigField[] {
	return [
		{
			type: 'textinput',
			id: 'host',
			label: 'Restream PC IP / hostname',
			width: 6,
			default: '127.0.0.1',
			tooltip: '127.0.0.1 when Companion runs on the Restream PC. Another PC: tick "Allow other PCs" in Restream > Control.',
		},
		{ type: 'number', id: 'port', label: 'Control API port', width: 3, min: 1024, max: 65535, default: 3181 },
		{ type: 'number', id: 'poll_ms', label: 'Update every (ms)', width: 3, min: 250, max: 5000, default: 500 },
		{
			type: 'secret-text',
			id: 'key',
			label: 'Restream control key',
			width: 9,
			default: '',
			minLength: 16,
			tooltip: 'Restream > Control tab > Copy.',
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
			port: config?.port === undefined ? 3181 : Number(config.port),
			poll_ms: Math.max(250, Math.min(5000, Number(config?.poll_ms) || 500)),
		},
		secrets: { key: String(secrets?.key ?? '').trim() },
	}
}

export function getConfigError(config: ModuleConfig, secrets: ModuleSecrets): string | undefined {
	if (!config.host) return 'Restream IP / hostname is empty'
	if (config.host.includes('://') || config.host.includes('/')) return 'Enter only the IP or hostname, without http:// or a path'
	if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) return 'Port must be a whole number from 1024 to 65535'
	if (!secrets.key) return 'Control key is empty; copy it from Restream > Control'
	if (secrets.key.length < 16) return 'Control key is too short; copy the complete key'
	return undefined
}
