# dsh-sleep — Agent Guide

## Plugin overview

Bundle-style DSH plugin exposing a single `sleep` tool that lets the model pause for a configurable number of milliseconds, honoring cancellation. Pure host half (no client UI); the generic tool card is used for rendering.

## Key conventions

- **Bundle form**: `cordis.patch.yml` inserts one plugin row; `package.json` has `dsh.bundle.patch`. No source patches to DSH staging.
- **Pre-built `lib/` strategy**: `lib/` is committed (not in `.gitignore`); no `prepare` script; `github:` install works out of the box (private `@deepseek-ai/dsh-tools` peer cannot be fetched in pnpm's temporary `prepare` directory).
- **Host-only**: no `dshClient` block, no client bundle, no CSS pipeline. The host registers one tool and that's it.
- **Peer deps**: `@deepseek-ai/cordis` + `@deepseek-ai/dsh-tools` + `@deepseek-ai/dsh-llm` (provided by host; declared `^0.1.2-rc.1`). `schemastery` is a direct dependency (config validator).
- **Ambient types**: `src/types.d.ts` declares `@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-llm`, and `@deepseek-ai/cordis` for standalone typecheck (the alpha peers are not on npm, so devDependencies deliberately omit them; local dev resolves their *runtime* for vitest via manual junctions into a DSH v0.1.2-alpha.1 checkout).
- **ESM-only**: `"type": "module"`, relative imports use `.js` extensions (NodeNext).
- **defineTool contract**: `execute` returns a canonical JSON value; `render` is a separate pure projection. `exec.signal` honored at every await point.

## File responsibilities

| File | Role |
|------|------|
| `src/index.ts` | Entry: `name`, `inject = ['tools']`, `Config` (Schemastery), `apply` |
| `src/tools.ts` | `resolveDuration`, `sleepWithCancellation`, `renderSleepOutput`, `registerTools` |
| `src/types.d.ts` | Ambient declarations for peer-dep modules |
| `tests/tools.spec.ts` | Unit tests (no live host needed) |

## Commands

```sh
pnpm run typecheck    # tsc --noEmit (src only)
pnpm test             # vitest run
pnpm run build        # tsc -p tsconfig.json → lib/
```

## Cancellation semantics

Cancellation is reported in the canonical value, not thrown:

- `sleepWithCancellation` resolves with `{ cancelled: true, actualMs }` when `signal` aborts mid-sleep.
- An already-aborted signal resolves immediately with `cancelled: true, actualMs: 0`.
- This follows C5 (infrastructure failures throw; business non-ideal states return a canonical value) — the model gets to see the cancellation outcome rather than an opaque error.

The `signal.addEventListener('abort', ...)` listener is removed on both completion and cancellation paths (no listener leak).

## Config hot-reload

Plugin config changes (cordis.yml edit, GUI settings) cause cordis to dispose the plugin fiber and re-`apply` with the fresh config. `ctx.tools.register` is effect-based, so the old tool is unregistered automatically and the new one re-registers — no manual hot-swap code needed.

## Gotchas

- `maxDurationMs` defaults to 60000 (1 min). Larger requests are clamped, not rejected — the model sees `clamped: true` in the result and can adjust.
- `defaultDurationMs` defaults to 0; if the model omits `duration_ms`, the tool resolves immediately. Set a non-zero default in `cordis.patch.yml` if you want a different fallback.
- The integer schema rejects fractional `duration_ms` at the validator boundary before `execute` runs; the floor + clamped path in `resolveDuration` only triggers for fractional defaults or non-finite inputs.
- `actual_ms` is measured with `Date.now()` before/after the timer — coarse-grained, suitable for human-readable reporting, not for nanosecond benchmarks.
