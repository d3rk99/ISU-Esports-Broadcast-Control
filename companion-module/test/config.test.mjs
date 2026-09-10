import assert from 'node:assert/strict'
import test from 'node:test'
// eslint-disable-next-line n/no-unpublished-import
import { GetConfigFields, getConfigError, normalizeConnectionConfig } from '../dist/config.js'

test('stores the controller address as config and the API key as a secret', () => {
	const fields = GetConfigFields()
	assert.equal(fields.find((field) => field.id === 'host')?.type, 'textinput')
	assert.equal(fields.find((field) => field.id === 'token')?.type, 'secret-text')
})

test('migrates values saved with the 0.1.0 field types', () => {
	const normalized = normalizeConnectionConfig({ port: 3176, token: '0123456789abcdef' }, { host: '134.50.16.22' })

	assert.deepEqual(normalized, {
		config: { host: '134.50.16.22', port: 3176 },
		secrets: { token: '0123456789abcdef' },
	})
	assert.equal(getConfigError(normalized.config, normalized.secrets), undefined)
})

test('returns a useful message for a full URL in the hostname field', () => {
	assert.match(
		getConfigError({ host: 'http://134.50.16.22:3176/api/companion', port: 3176 }, { token: '0123456789abcdef' }) ?? '',
		/only the controller IP or hostname/,
	)
})
