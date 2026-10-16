import type ModuleInstance from './main.js'
import { MAX_OUTPUTS } from './variables.js'

type Out = { output: string }
export type FeedbacksSchema = {
	connected: { type: 'boolean'; options: Record<string, never> }
	on_air: { type: 'boolean'; options: Record<string, never> }
	filling: { type: 'boolean'; options: Record<string, never> }
	draining: { type: 'boolean'; options: Record<string, never> }
	recording: { type: 'boolean'; options: Record<string, never> }
	monitor: { type: 'boolean'; options: Record<string, never> }
	all_live: { type: 'boolean'; options: Record<string, never> }
	output_live: { type: 'boolean'; options: Out }
	output_problem: { type: 'boolean'; options: Out }
	error: { type: 'boolean'; options: Record<string, never> }
	audio_clipping: { type: 'boolean'; options: Record<string, never> }
}

export const OUTPUT_CHOICES = Array.from({ length: MAX_OUTPUTS }, (_v, i) => ({ id: String(i + 1), label: `Destination ${i + 1}` }))
const outs = (suffix: string) => Array.from({ length: MAX_OUTPUTS }, (_v, i) => `out${i + 1}_${suffix}`)
export const FEEDBACK_VARIABLES: Record<keyof FeedbacksSchema, string[]> = {
	connected: ['connection_ok'],
	on_air: ['on_air'],
	filling: ['state'],
	draining: ['state'],
	recording: ['recording'],
	monitor: ['monitor'],
	all_live: ['all_enabled_live'],
	output_live: outs('live'),
	output_problem: outs('state'),
	error: ['error'],
	audio_clipping: ['audio_peak_l', 'audio_peak_r'],
}

export const RED = 0xc62828
export const GREEN = 0x2e7d32
export const AMBER = 0xb26a00
export const BLUE = 0x1565c0
export const WHITE = 0xffffff
const outputOption = { id: 'output' as const, type: 'dropdown' as const, label: 'Destination', default: '1', choices: OUTPUT_CHOICES }

export function UpdateFeedbacks(self: ModuleInstance): void {
	const v = (id: string) => self.getVariableValue(id)
	const peak = (id: string) => (typeof v(id) === 'number' ? (v(id) as number) : -200)
	self.setFeedbackDefinitions({
		connected: { name: 'Restream connected', type: 'boolean', defaultStyle: { bgcolor: GREEN, color: WHITE }, options: [], callback: () => v('connection_ok') === true },
		on_air: { name: 'ON AIR (delayed stream going out)', type: 'boolean', defaultStyle: { bgcolor: RED, color: WHITE }, options: [], callback: () => v('on_air') === true },
		filling: { name: 'Delay filling (live, not on air yet)', type: 'boolean', defaultStyle: { bgcolor: AMBER, color: WHITE }, options: [], callback: () => v('state') === 'FILLING' },
		draining: { name: 'Stopping (buffer playing out)', type: 'boolean', defaultStyle: { bgcolor: AMBER, color: WHITE }, options: [], callback: () => v('state') === 'DRAINING' },
		recording: { name: 'Recording', type: 'boolean', defaultStyle: { bgcolor: RED, color: WHITE }, options: [], callback: () => v('recording') === true },
		monitor: { name: 'Audio monitor on', type: 'boolean', defaultStyle: { bgcolor: BLUE, color: WHITE }, options: [], callback: () => v('monitor') === true },
		all_live: { name: 'Every enabled destination streaming', type: 'boolean', defaultStyle: { bgcolor: GREEN, color: WHITE }, options: [], callback: () => v('all_enabled_live') === true },
		output_live: {
			name: 'Destination streaming',
			type: 'boolean',
			defaultStyle: { bgcolor: GREEN, color: WHITE },
			options: [outputOption],
			callback: (f) => v(`out${f.options.output}_live`) === true,
		},
		output_problem: {
			name: 'Destination has a problem (reconnecting / lagging)',
			type: 'boolean',
			defaultStyle: { bgcolor: AMBER, color: WHITE },
			options: [outputOption],
			callback: (f) => ['RECONNECTING', 'LAGGING'].includes(String(v(`out${f.options.output}_state`))),
		},
		error: { name: 'Restream reported an error (last 60 s)', type: 'boolean', defaultStyle: { bgcolor: RED, color: WHITE }, options: [], callback: () => Boolean(v('error')) },
		audio_clipping: {
			name: 'Audio peak above -1 dBFS',
			type: 'boolean',
			defaultStyle: { bgcolor: RED, color: WHITE },
			options: [],
			callback: () => Math.max(peak('audio_peak_l'), peak('audio_peak_r')) > -1,
		},
	})
}
