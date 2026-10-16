import type ModuleInstance from './main.js'

type Op = 'on' | 'off' | 'toggle'
export type ActionsSchema = {
	go_live: { options: Record<string, never> }
	stop: { options: Record<string, never> }
	cut: { options: Record<string, never> }
	recording: { options: { operation: Op } }
	monitor: { options: { operation: Op } }
	gain_set: { options: { db: number } }
	gain_adjust: { options: { db: number } }
	monitor_volume_set: { options: { db: number } }
	monitor_volume_adjust: { options: { db: number } }
}

const OPS = [
	{ id: 'toggle', label: 'Toggle' },
	{ id: 'on', label: 'On / start' },
	{ id: 'off', label: 'Off / stop' },
]
const op = { id: 'operation' as const, type: 'dropdown' as const, label: 'Operation', default: 'toggle', choices: OPS }
const db = (label: string, def: number, min: number, max: number) => ({ id: 'db' as const, type: 'number' as const, label, default: def, min, max, step: 0.5 })

export function UpdateActions(self: ModuleInstance): void {
	self.setActionDefinitions({
		go_live: { name: 'Go Live (start capture, delay, destinations, recording)', options: [], callback: async () => self.command('/api/go-live') },
		stop: { name: 'Stop (let the buffered delay play out, then disconnect)', options: [], callback: async () => self.command('/api/stop') },
		cut: { name: 'CUT (discard the delay buffer, disconnect NOW)', options: [], callback: async () => self.command('/api/cut') },
		recording: {
			name: 'Recording: start / stop / toggle (needs a running session)',
			options: [op],
			callback: async (e) => self.command(`/api/recording/${e.options.operation}`),
		},
		monitor: { name: 'Audio monitor: on / off / toggle', options: [op], callback: async (e) => self.command(`/api/monitor/${e.options.operation}`) },
		gain_set: { name: 'Program gain: set dB', options: [db('Gain dB', 0, -30, 20)], callback: async (e) => self.command(`/api/gain?db=${Number(e.options.db)}`) },
		gain_adjust: { name: 'Program gain: change by dB', options: [db('Change dB (+/-)', 1, -30, 30)], callback: async (e) => self.command(`/api/gain/adjust?db=${Number(e.options.db)}`) },
		monitor_volume_set: { name: 'Monitor volume: set dB', options: [db('Volume dB', 0, -60, 12)], callback: async (e) => self.command(`/api/monitor-volume?db=${Number(e.options.db)}`) },
		monitor_volume_adjust: { name: 'Monitor volume: change by dB', options: [db('Change dB (+/-)', 3, -60, 60)], callback: async (e) => self.command(`/api/monitor-volume/adjust?db=${Number(e.options.db)}`) },
	})
}
