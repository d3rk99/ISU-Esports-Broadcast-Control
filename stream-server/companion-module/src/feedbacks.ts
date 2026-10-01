import type ModuleInstance from './main.js'
import { OUTPUT_CHOICES } from './actions.js'

type Out = { output: string }
export type FeedbacksSchema = {
	connected: { type: 'boolean'; options: Record<string, never> }
	output_live: { type: 'boolean'; options: Out }
	output_healthy: { type: 'boolean'; options: Out }
	output_problem: { type: 'boolean'; options: Out }
	all_healthy: { type: 'boolean'; options: Record<string, never> }
	any_live: { type: 'boolean'; options: Record<string, never> }
	program_problem: { type: 'boolean'; options: Record<string, never> }
	delay_ready: { type: 'boolean'; options: Record<string, never> }
	recording: { type: 'boolean'; options: Record<string, never> }
	audio_silent: { type: 'boolean'; options: Record<string, never> }
}

export const FEEDBACK_VARIABLES: Record<keyof FeedbacksSchema, string[]> = {
	connected: ['connection_ok'],
	output_live: Array.from({ length: 8 }, (_v, i) => `out${i + 1}_live`),
	output_healthy: Array.from({ length: 8 }, (_v, i) => `out${i + 1}_healthy`),
	output_problem: Array.from({ length: 8 }, (_v, i) => `out${i + 1}_health`),
	all_healthy: ['all_enabled_healthy'],
	any_live: ['any_live'],
	program_problem: ['program_healthy', 'program_problems'],
	delay_ready: ['delay_ready'],
	recording: ['recording'],
	audio_silent: ['audio_silent'],
}

const RED = 0xc62828
const GREEN = 0x2e7d32
const AMBER = 0xb26a00
const WHITE = 0xffffff
const outputOption = {
	id: 'output' as const,
	type: 'dropdown' as const,
	label: 'Destination',
	default: '1',
	choices: OUTPUT_CHOICES,
}

export function UpdateFeedbacks(self: ModuleInstance): void {
	const v = (id: string) => self.getVariableValue(id)
	self.setFeedbackDefinitions({
		connected: {
			name: 'Stream Server connected',
			type: 'boolean',
			defaultStyle: { bgcolor: GREEN, color: WHITE },
			options: [],
			callback: () => v('connection_ok') === true,
		},
		output_live: {
			name: 'Destination is LIVE (connected)',
			type: 'boolean',
			defaultStyle: { bgcolor: RED, color: WHITE },
			options: [outputOption],
			callback: (f) => v(`out${f.options.output}_live`) === true,
		},
		output_healthy: {
			name: 'Destination is LIVE and HEALTHY (data flowing, not falling behind)',
			type: 'boolean',
			defaultStyle: { bgcolor: GREEN, color: WHITE },
			options: [outputOption],
			callback: (f) => v(`out${f.options.output}_healthy`) === true,
		},
		output_problem: {
			name: 'Destination has a problem (stalled, lagging, reconnecting or error)',
			type: 'boolean',
			defaultStyle: { bgcolor: AMBER, color: WHITE },
			options: [outputOption],
			callback: (f) => ['STALLED', 'LAGGING', 'FAILED'].includes(String(v(`out${f.options.output}_health`))),
		},
		all_healthy: {
			name: 'Every enabled destination live + healthy',
			type: 'boolean',
			defaultStyle: { bgcolor: GREEN, color: WHITE },
			options: [],
			callback: () => v('all_enabled_healthy') === true,
		},
		any_live: {
			name: 'Any destination live (ON AIR)',
			type: 'boolean',
			defaultStyle: { bgcolor: RED, color: WHITE },
			options: [],
			callback: () => v('any_live') === true,
		},
		program_problem: {
			name: 'Program problem (encoder, fps, dropped frames or audio)',
			type: 'boolean',
			defaultStyle: { bgcolor: AMBER, color: WHITE },
			options: [],
			// "BUFFERING" alone is normal while the delay fills, so it is not a problem here.
			callback: () =>
				String(v('program_problems') || '')
					.split(',')
					.some((p) => p && p !== 'BUFFERING'),
		},
		delay_ready: {
			name: 'Delay buffer ready (outputs unlocked)',
			type: 'boolean',
			defaultStyle: { bgcolor: GREEN, color: WHITE },
			options: [],
			callback: () => v('delay_ready') === true,
		},
		recording: {
			name: 'Recording',
			type: 'boolean',
			defaultStyle: { bgcolor: RED, color: WHITE },
			options: [],
			callback: () => v('recording') === true,
		},
		audio_silent: {
			name: 'Audio missing / silent',
			type: 'boolean',
			defaultStyle: { bgcolor: AMBER, color: WHITE },
			options: [],
			callback: () => v('audio_silent') === true,
		},
	})
}
