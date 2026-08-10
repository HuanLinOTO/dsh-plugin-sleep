/**
 * index.ts — dsh-sleep cordis plugin entry (host half).
 *
 * Single model-facing tool: `sleep`. The host registers it once at load.
 * Tool registration is effect-based: disposing the plugin fiber
 * (e.g., on config change) automatically unregisters the tool, and the
 * next apply() re-registers with the fresh config.
 *
 * Architecture:
 *   - `sleep` tool: pause for N ms, honoring exec.signal cancellation.
 *     Cancelled sleeps resolve to a canonical value (cancelled: true)
 *     rather than throwing — cancellation is a business non-ideal state,
 *     not infrastructure failure (per plugin-development-guide.md §3 C5).
 *
 * @module @dsh-external/dsh-sleep
 */

import z from 'schemastery'
import type { Context } from 'cordis'
import { registerTools, type ResolvedConfig } from './tools.js'

export const name = 'dsh-sleep'
export const inject = ['tools']

export interface Config {
  maxDurationMs?: number
  defaultDurationMs?: number
}

export const Config: z<Config> = z.object({
  maxDurationMs: z.number().default(60000).description('Maximum sleep duration in milliseconds. Larger requests are clamped to this value.'),
  defaultDurationMs: z.number().default(0).description('Fallback duration when the model omits duration_ms. Defaults to 0.'),
})

export function resolveConfig(config: Config): ResolvedConfig {
  const max = typeof config.maxDurationMs === 'number' && config.maxDurationMs >= 0 ? config.maxDurationMs : 60000
  const def = typeof config.defaultDurationMs === 'number' && config.defaultDurationMs >= 0 ? config.defaultDurationMs : 0
  return {
    maxDurationMs: max,
    defaultDurationMs: Math.min(def, max),
  }
}

export function apply(ctx: Context, config: Config = {} as Config): void {
  const resolved = resolveConfig(config)
  registerTools(ctx, () => resolved)
}

