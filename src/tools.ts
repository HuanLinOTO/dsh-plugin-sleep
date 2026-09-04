/**
 * tools.ts — `sleep` model-facing tool.
 *
 * Conventions (per plugin-development-guide.md §3):
 *   C4 — execute returns a canonical JSON value; render is a separate pure projection.
 *   C5 — cancellation is a non-ideal business outcome, represented in the value
 *        (cancelled: true) rather than thrown. Infrastructure failures throw.
 *   C6 — exec.signal is honored at every await point.
 *   C10 — no UI-specific formats in the canonical value.
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

export interface ResolvedConfig {
  maxDurationMs: number
  defaultDurationMs: number
}

export interface SleepArgs {
  duration_ms?: number
  reason?: string
}

export interface SleepResult {
  requested_ms: number
  actual_ms: number
  cancelled: boolean
  clamped: boolean
  reason?: string
}

export interface SleepOutcome {
  cancelled: boolean
  actualMs: number
}

/**
 * Resolve a sleep duration against the plugin config, clamping to the
 * configured maximum. Returns the resolved duration and whether it was
 * clamped. Negative durations are clamped to 0.
 */
export function resolveDuration(
  requestedMs: number | undefined,
  config: ResolvedConfig,
): { durationMs: number; clamped: boolean } {
  const fallback = config.defaultDurationMs
  const raw = typeof requestedMs === 'number' && Number.isFinite(requestedMs) ? requestedMs : fallback
  const nonNegative = raw < 0 ? 0 : Math.floor(raw)
  if (nonNegative > config.maxDurationMs) {
    return { durationMs: config.maxDurationMs, clamped: true }
  }
  return { durationMs: nonNegative, clamped: nonNegative !== raw }
}

/**
 * Sleep for `durationMs`, resolving early with `cancelled: true` if `signal`
 * aborts. The signal is never thrown through — cancellation is a normal
 * business outcome reported in the canonical value (C5).
 *
 * A zero or negative `durationMs` resolves synchronously without scheduling
 * a timer.
 */
export function sleepWithCancellation(
  durationMs: number,
  signal: AbortSignal,
): Promise<SleepOutcome> {
  if (durationMs <= 0) {
    return Promise.resolve({ cancelled: false, actualMs: 0 })
  }
  if (signal.aborted) {
    return Promise.resolve({ cancelled: true, actualMs: 0 })
  }
  const start = Date.now()
  return new Promise<SleepOutcome>((resolve) => {
    const onAbort = (): void => {
      cleanup()
      resolve({ cancelled: true, actualMs: Date.now() - start })
    }
    const onTimeout = (): void => {
      cleanup()
      resolve({ cancelled: false, actualMs: Date.now() - start })
    }
    const timer = setTimeout(onTimeout, durationMs)
    function cleanup(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export function renderSleepOutput(value: SleepResult): string {
  const lines: string[] = [
    `Slept ${value.actual_ms}ms (requested ${value.requested_ms}ms).`,
  ]
  if (value.clamped) lines.push('Duration was clamped to the configured maximum.')
  if (value.cancelled) lines.push('Sleep was cancelled by an abort signal before completing.')
  if (value.reason) lines.push(`Reason: ${value.reason}`)
  return lines.join('\n')
}

function textRender(fn: (value: SleepResult) => string): (_args: unknown, value: unknown) => ContentBlock[] {
  return (_args, value) => [{ type: 'text', text: fn(value as SleepResult) }]
}

export function registerTools(ctx: Context, getConfig: () => ResolvedConfig): void {
  const config = (): ResolvedConfig => getConfig()

  ctx.tools.register(defineTool({
    name: 'sleep',
    description:
      'Pause execution for the given number of milliseconds, then return. '
      + 'Use this when you need to wait for a time-based condition to become true '
      + '(e.g., a server restart, a debounce window, a retry backoff) and no '
      + 'event-based tool fits. The duration is bounded by the plugin\'s '
      + 'maxDurationMs config (default 60000ms); larger values are clamped. '
      + 'If the surrounding turn is cancelled while sleeping, the tool returns '
      + 'early with cancelled=true instead of throwing.',
    parameters: {
      duration_ms: {
        type: 'integer',
        required: true,
        description:
          'Number of milliseconds to sleep. Must be >= 0. Values above the '
          + 'plugin\'s maxDurationMs are clamped to that maximum and the result '
          + 'reports clamped=true.',
      },
      reason: {
        type: 'string',
        description: 'Optional human-readable explanation of why the sleep is needed.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          requested_ms: {
            type: 'integer',
            required: true,
            description: 'The duration originally requested by the caller.',
          },
          actual_ms: {
            type: 'integer',
            required: true,
            description: 'Milliseconds actually spent sleeping (may be less than requested_ms on cancellation).',
          },
          cancelled: {
            type: 'boolean',
            required: true,
            description: 'True if the sleep was interrupted by an abort signal before completing.',
          },
          clamped: {
            type: 'boolean',
            description: 'True if the requested duration exceeded the configured maximum and was clamped.',
          },
          reason: {
            type: 'string',
            description: 'Echo of the caller-supplied reason, if any.',
          },
        },
      },
      render: textRender(renderSleepOutput),
    },
    execute: async (args: unknown, exec: ToolRunContext): Promise<SleepResult> => {
      const a = args as SleepArgs
      const cfg = config()
      const requestedRaw = typeof a.duration_ms === 'number' ? a.duration_ms : cfg.defaultDurationMs
      const { durationMs, clamped } = resolveDuration(requestedRaw, cfg)

      const outcome = await sleepWithCancellation(durationMs, exec.signal)

      const result: SleepResult = {
        requested_ms: Math.floor(requestedRaw),
        actual_ms: outcome.actualMs,
        cancelled: outcome.cancelled,
        clamped,
      }
      if (a.reason !== undefined && a.reason !== '') result.reason = a.reason
      return result
    },
  }))
}
