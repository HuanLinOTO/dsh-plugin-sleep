import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Context } from 'cordis'

vi.mock('@deepseek-ai/dsh-tools', () => ({
  defineTool: vi.fn((opts: unknown) => opts),
}))

import {
  resolveDuration,
  sleepWithCancellation,
  renderSleepOutput,
  registerTools,
  type ResolvedConfig,
  type SleepResult,
} from '../src/tools.js'
import { defineTool } from '@deepseek-ai/dsh-tools'

const defaultConfig: ResolvedConfig = {
  maxDurationMs: 60000,
  defaultDurationMs: 0,
}

function makeCtx(): Context & { registered: unknown[] } {
  const registered: unknown[] = []
  const ctx = {
    tools: {
      register(definition: unknown): () => void {
        registered.push(definition)
        return () => {
          const i = registered.indexOf(definition)
          if (i >= 0) registered.splice(i, 1)
        }
      },
      schemas(): readonly { name: string; description: string }[] {
        return registered.map((d) => {
          const opts = d as { name: string; description: string }
          return { name: opts.name, description: opts.description }
        })
      },
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  } as unknown as Context & { registered: unknown[] }
  Object.defineProperty(ctx, 'registered', { value: registered })
  return ctx
}

function getRegisteredTool(ctx: Context & { registered: unknown[] }): {
  name: string
  description: string
  parameters: unknown
  output: { schema: unknown; render: (args: unknown, value: unknown) => unknown[] }
  execute: (args: unknown, exec: { signal: AbortSignal }) => Promise<unknown>
} {
  expect(ctx.registered).toHaveLength(1)
  return ctx.registered[0] as ReturnType<typeof getRegisteredTool>
}

describe('resolveDuration', () => {
  it('returns the value unchanged when within bounds', () => {
    const r = resolveDuration(1000, defaultConfig)
    expect(r.durationMs).toBe(1000)
    expect(r.clamped).toBe(false)
  })

  it('clamps to maxDurationMs when value exceeds', () => {
    const r = resolveDuration(120000, defaultConfig)
    expect(r.durationMs).toBe(60000)
    expect(r.clamped).toBe(true)
  })

  it('clamps negative values to 0', () => {
    const r = resolveDuration(-500, defaultConfig)
    expect(r.durationMs).toBe(0)
    expect(r.clamped).toBe(true)
  })

  it('floors fractional values and marks clamped', () => {
    const r = resolveDuration(1500.7, defaultConfig)
    expect(r.durationMs).toBe(1500)
    expect(r.clamped).toBe(true)
  })

  it('returns default when requested is undefined', () => {
    const cfg: ResolvedConfig = { maxDurationMs: 60000, defaultDurationMs: 2500 }
    const r = resolveDuration(undefined, cfg)
    expect(r.durationMs).toBe(2500)
    expect(r.clamped).toBe(false)
  })

  it('returns default when requested is NaN', () => {
    const r = resolveDuration(Number.NaN, defaultConfig)
    expect(r.durationMs).toBe(0)
    expect(r.clamped).toBe(false)
  })

  it('returns default when requested is Infinity', () => {
    const cfg: ResolvedConfig = { maxDurationMs: 60000, defaultDurationMs: 1000 }
    const r = resolveDuration(Number.POSITIVE_INFINITY, cfg)
    expect(r.durationMs).toBe(1000)
    expect(r.clamped).toBe(false)
  })

  it('floors default when default is fractional', () => {
    const cfg: ResolvedConfig = { maxDurationMs: 60000, defaultDurationMs: 1234.9 }
    const r = resolveDuration(undefined, cfg)
    expect(r.durationMs).toBe(1234)
    expect(r.clamped).toBe(true)
  })

  it('clamps default to max when default exceeds max', () => {
    const cfg: ResolvedConfig = { maxDurationMs: 5000, defaultDurationMs: 99999 }
    const r = resolveDuration(undefined, cfg)
    expect(r.durationMs).toBe(5000)
    expect(r.clamped).toBe(true)
  })

  it('treats zero as valid (not clamped)', () => {
    const r = resolveDuration(0, defaultConfig)
    expect(r.durationMs).toBe(0)
    expect(r.clamped).toBe(false)
  })

  it('clamps exactly equal to max is not clamped', () => {
    const r = resolveDuration(60000, defaultConfig)
    expect(r.durationMs).toBe(60000)
    expect(r.clamped).toBe(false)
  })
})

describe('sleepWithCancellation', () => {
  it('resolves immediately with cancelled=false for zero duration', async () => {
    const controller = new AbortController()
    const start = Date.now()
    const out = await sleepWithCancellation(0, controller.signal)
    const elapsed = Date.now() - start
    expect(out.cancelled).toBe(false)
    expect(out.actualMs).toBe(0)
    expect(elapsed).toBeLessThan(20)
  })

  it('resolves immediately with cancelled=false for negative duration', async () => {
    const controller = new AbortController()
    const out = await sleepWithCancellation(-100, controller.signal)
    expect(out.cancelled).toBe(false)
    expect(out.actualMs).toBe(0)
  })

  it('resolves with cancelled=true when signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const out = await sleepWithCancellation(1000, controller.signal)
    expect(out.cancelled).toBe(true)
    expect(out.actualMs).toBe(0)
  })

  it('completes normally when the timer fires', async () => {
    const controller = new AbortController()
    const out = await sleepWithCancellation(50, controller.signal)
    expect(out.cancelled).toBe(false)
    expect(out.actualMs).toBeGreaterThanOrEqual(40)
    expect(out.actualMs).toBeLessThan(500)
  })

  it('returns cancelled=true when signal aborts mid-sleep', async () => {
    const controller = new AbortController()
    const promise = sleepWithCancellation(5000, controller.signal)
    setTimeout(() => controller.abort(), 20)
    const out = await promise
    expect(out.cancelled).toBe(true)
    expect(out.actualMs).toBeGreaterThanOrEqual(10)
    expect(out.actualMs).toBeLessThan(500)
  })

  it('does not keep listeners attached after completion', async () => {
    const controller = new AbortController()
    const addSpy = vi.spyOn(controller.signal, 'addEventListener')
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener')
    await sleepWithCancellation(10, controller.signal)
    const adds = addSpy.mock.calls.length
    const removes = removeSpy.mock.calls.length
    expect(adds).toBe(1)
    expect(removes).toBe(1)
    addSpy.mockRestore()
    removeSpy.mockRestore()
  })

  it('does not keep listeners attached after cancellation', async () => {
    const controller = new AbortController()
    const addSpy = vi.spyOn(controller.signal, 'addEventListener')
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener')
    const promise = sleepWithCancellation(5000, controller.signal)
    setTimeout(() => controller.abort(), 10)
    await promise
    const adds = addSpy.mock.calls.length
    const removes = removeSpy.mock.calls.length
    expect(adds).toBe(1)
    expect(removes).toBe(1)
    addSpy.mockRestore()
    removeSpy.mockRestore()
  })

  it('does not call onTimeout after cancellation', async () => {
    const controller = new AbortController()
    const promise = sleepWithCancellation(5000, controller.signal)
    setTimeout(() => controller.abort(), 10)
    const out = await promise
    expect(out.cancelled).toBe(true)
    await new Promise((r) => setTimeout(r, 60))
    expect(out.cancelled).toBe(true)
  })
})

describe('renderSleepOutput', () => {
  it('renders a normal completed sleep', () => {
    const text = renderSleepOutput({
      requested_ms: 1000,
      actual_ms: 1002,
      cancelled: false,
      clamped: false,
    })
    expect(text).toContain('Slept 1002ms')
    expect(text).toContain('requested 1000ms')
    expect(text).not.toContain('clamped')
    expect(text).not.toContain('cancelled')
  })

  it('renders a clamped sleep', () => {
    const text = renderSleepOutput({
      requested_ms: 120000,
      actual_ms: 60000,
      cancelled: false,
      clamped: true,
    })
    expect(text).toContain('clamped')
  })

  it('renders a cancelled sleep', () => {
    const text = renderSleepOutput({
      requested_ms: 5000,
      actual_ms: 50,
      cancelled: true,
      clamped: false,
    })
    expect(text).toContain('cancelled')
  })

  it('renders a reason when supplied', () => {
    const text = renderSleepOutput({
      requested_ms: 1000,
      actual_ms: 1000,
      cancelled: false,
      clamped: false,
      reason: 'waiting for server restart',
    })
    expect(text).toContain('waiting for server restart')
  })

  it('omits reason line when not supplied', () => {
    const text = renderSleepOutput({
      requested_ms: 1000,
      actual_ms: 1000,
      cancelled: false,
      clamped: false,
    })
    expect(text).not.toContain('Reason:')
  })
})

describe('registerTools', () => {
  beforeEach(() => {
    vi.mocked(defineTool).mockClear()
  })

  it('registers exactly one tool named sleep', () => {
    const ctx = makeCtx()
    registerTools(ctx, () => defaultConfig)
    const tool = getRegisteredTool(ctx)
    expect(defineTool).toHaveBeenCalledTimes(1)
    expect(tool.name).toBe('sleep')
    expect(tool.description.length).toBeGreaterThan(0)
  })

  it('execute returns canonical SleepResult for a normal sleep', async () => {
    const ctx = makeCtx()
    registerTools(ctx, () => defaultConfig)
    const tool = getRegisteredTool(ctx)
    const exec = { signal: new AbortController().signal }
    const result = (await tool.execute({ duration_ms: 30 }, exec)) as SleepResult
    expect(result.requested_ms).toBe(30)
    expect(result.cancelled).toBe(false)
    expect(result.clamped).toBe(false)
    expect(result.actual_ms).toBeGreaterThanOrEqual(20)
    expect(result.actual_ms).toBeLessThan(500)
    expect(result.reason).toBeUndefined()
  })

  it('execute clamps values above maxDurationMs', async () => {
    const ctx = makeCtx()
    registerTools(ctx, () => ({ maxDurationMs: 30, defaultDurationMs: 0 }))
    const tool = getRegisteredTool(ctx)
    const exec = { signal: new AbortController().signal }
    const result = (await tool.execute({ duration_ms: 999999 }, exec)) as SleepResult
    expect(result.requested_ms).toBe(999999)
    expect(result.clamped).toBe(true)
    expect(result.cancelled).toBe(false)
    expect(result.actual_ms).toBeLessThan(200)
  })

  it('execute returns cancelled=true when signal aborts mid-sleep', async () => {
    const ctx = makeCtx()
    registerTools(ctx, () => defaultConfig)
    const tool = getRegisteredTool(ctx)
    const controller = new AbortController()
    const promise = tool.execute({ duration_ms: 5000, reason: 'debounce' }, { signal: controller.signal })
    setTimeout(() => controller.abort(), 20)
    const result = (await promise) as SleepResult
    expect(result.cancelled).toBe(true)
    expect(result.requested_ms).toBe(5000)
    expect(result.clamped).toBe(false)
    expect(result.reason).toBe('debounce')
  })

  it('execute returns cancelled=true when signal is already aborted', async () => {
    const ctx = makeCtx()
    registerTools(ctx, () => defaultConfig)
    const tool = getRegisteredTool(ctx)
    const controller = new AbortController()
    controller.abort()
    const result = (await tool.execute({ duration_ms: 1000 }, { signal: controller.signal })) as SleepResult
    expect(result.cancelled).toBe(true)
    expect(result.actual_ms).toBe(0)
  })

  it('execute uses defaultDurationMs when duration_ms is omitted', async () => {
    const ctx = makeCtx()
    registerTools(ctx, () => ({ maxDurationMs: 60000, defaultDurationMs: 20 }))
    const tool = getRegisteredTool(ctx)
    const exec = { signal: new AbortController().signal }
    const result = (await tool.execute({}, exec)) as SleepResult
    expect(result.requested_ms).toBe(20)
    expect(result.cancelled).toBe(false)
  })

  it('execute with duration_ms=0 resolves without sleeping', async () => {
    const ctx = makeCtx()
    registerTools(ctx, () => defaultConfig)
    const tool = getRegisteredTool(ctx)
    const exec = { signal: new AbortController().signal }
    const result = (await tool.execute({ duration_ms: 0 }, exec)) as SleepResult
    expect(result.requested_ms).toBe(0)
    expect(result.actual_ms).toBe(0)
    expect(result.cancelled).toBe(false)
  })

  it('execute clamps negative duration to 0', async () => {
    const ctx = makeCtx()
    registerTools(ctx, () => defaultConfig)
    const tool = getRegisteredTool(ctx)
    const exec = { signal: new AbortController().signal }
    const result = (await tool.execute({ duration_ms: -100 }, exec)) as SleepResult
    expect(result.requested_ms).toBe(-100)
    expect(result.actual_ms).toBe(0)
    expect(result.clamped).toBe(true)
    expect(result.cancelled).toBe(false)
  })

  it('execute omits reason when caller supplies empty string', async () => {
    const ctx = makeCtx()
    registerTools(ctx, () => defaultConfig)
    const tool = getRegisteredTool(ctx)
    const exec = { signal: new AbortController().signal }
    const result = (await tool.execute({ duration_ms: 0, reason: '' }, exec)) as SleepResult
    expect(result.reason).toBeUndefined()
  })

  it('output.render returns a single text ContentBlock', () => {
    const ctx = makeCtx()
    registerTools(ctx, () => defaultConfig)
    const tool = getRegisteredTool(ctx)
    const value: SleepResult = {
      requested_ms: 100,
      actual_ms: 100,
      cancelled: false,
      clamped: false,
    }
    const blocks = tool.output.render({}, value)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toEqual({ type: 'text', text: expect.stringContaining('Slept') })
  })

  it('output.schema is a closed object with required core fields', () => {
    const ctx = makeCtx()
    registerTools(ctx, () => defaultConfig)
    const tool = getRegisteredTool(ctx)
    const schema = tool.output.schema as {
      type: string
      additionalProperties: boolean
      properties: Record<string, { required?: true; type: string }>
    }
    expect(schema.type).toBe('object')
    expect(schema.additionalProperties).toBe(false)
    expect(schema.properties.requested_ms.required).toBe(true)
    expect(schema.properties.actual_ms.required).toBe(true)
    expect(schema.properties.cancelled.required).toBe(true)
    expect(schema.properties.clamped.type).toBe('boolean')
    expect(schema.properties.reason.type).toBe('string')
  })

  it('parameters schema declares duration_ms required + reason optional', () => {
    const ctx = makeCtx()
    registerTools(ctx, () => defaultConfig)
    const tool = getRegisteredTool(ctx)
    const params = tool.parameters as {
      duration_ms: { type: string; required?: true }
      reason: { type: string; required?: true }
    }
    expect(params.duration_ms.type).toBe('integer')
    expect(params.duration_ms.required).toBe(true)
    expect(params.reason.type).toBe('string')
    expect(params.reason.required).toBeUndefined()
  })

  it('reads live config through the getter (maxDurationMs change reflects)', async () => {
    const ctx = makeCtx()
    let cfg: ResolvedConfig = { maxDurationMs: 100, defaultDurationMs: 0 }
    registerTools(ctx, () => cfg)
    const tool = getRegisteredTool(ctx)
    const exec = { signal: new AbortController().signal }
    const r1 = (await tool.execute({ duration_ms: 50 }, exec)) as SleepResult
    expect(r1.clamped).toBe(false)

    cfg = { maxDurationMs: 30, defaultDurationMs: 0 }
    const r2 = (await tool.execute({ duration_ms: 50 }, exec)) as SleepResult
    expect(r2.clamped).toBe(true)
    expect(r2.actual_ms).toBeLessThanOrEqual(50)
  })
})
