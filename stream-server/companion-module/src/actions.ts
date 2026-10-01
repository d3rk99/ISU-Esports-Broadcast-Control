import type ModuleInstance from './main.js'
import { MAX_OUTPUTS } from './variables.js'

type OutputOp = 'start' | 'stop' | 'toggle'

export type ActionsSchema = {
	stream_start_all: { options: Record<string, never> }
	stream_stop_all: { options: Record<string, never> }
	output_control: { options: { output: string; operation: OutputOp } }
	recording: { options: { operation: 'start' | 'stop' | 'toggle' } }
	set_delay: { options: { seconds: number } }
	reset_buffer: { options: Record<string, never> }
}

export const OUTPUT_CHOICES = Array.from({ length: MAX_OUTPUTS }, (_v, i) => ({
	id: String(i + 1),
	label: `Destination ${i + 1}`,
}))
const OP_CHOICES = [
	{ id: 'start', label: 'Start' },
	{ id: 'stop', label: 'Stop' },
	{ id: 'toggle', label: 'Toggle' },
]

export function UpdateActions(self: ModuleInstance): void {
	self.setActionDefinitions({
		stream_start_all: {
			name: 'Stream: START ALL enabled destinations',
			description: 'Refused by Stream Server until the delay buffer is full (the error shows in the log).',
			options: [],
			callback: async () => self.command('/api/stream/start'),
		},
		stream_stop_all: {
			name: 'Stream: STOP ALL destinations',
			options: [],
			callback: async () => self.command('/api/stream/stop'),
		},
		output_control: {
			name: 'Destination: Start / stop / toggle one',
			options: [
				{
					id: 'output',
					type: 'dropdown',
					label: 'Destination (order in Stream Server)',
					default: '1',
					choices: OUTPUT_CHOICES,
				},
				{ id: 'operation', type: 'dropdown', label: 'Operation', default: 'toggle', choices: OP_CHOICES },
			],
			callback: async (e) =>
				self.command(`/api/outputs/${encodeURIComponent(e.options.output)}/${e.options.operation}`),
		},
		recording: {
			name: 'Recording: Start / stop / toggle (live, undelayed)',
			options: [{ id: 'operation', type: 'dropdown', label: 'Operation', default: 'toggle', choices: OP_CHOICES }],
			callback: async (e) => self.command(`/api/recording/${e.options.operation}`),
		},
		set_delay: {
			name: 'Delay: Set seconds (stops outputs and refills the buffer)',
			options: [{ id: 'seconds', type: 'number', label: 'Seconds', default: 300, min: 0, max: 86400 }],
			callback: async (e) => self.command('/api/delay', { seconds: Math.round(Number(e.options.seconds)) }),
		},
		reset_buffer: {
			name: 'Delay: Reset buffer (stops outputs, refills from live input)',
			options: [],
			callback: async () => self.command('/api/buffer/reset'),
		},
	})
}
