import z from "schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
//#region src/tools.ts
/**
* Resolve a sleep duration against the plugin config, clamping to the
* configured maximum. Returns the resolved duration and whether it was
* clamped. Negative durations are clamped to 0.
*/
function resolveDuration(requestedMs, config) {
	const fallback = config.defaultDurationMs;
	const raw = typeof requestedMs === "number" && Number.isFinite(requestedMs) ? requestedMs : fallback;
	const nonNegative = raw < 0 ? 0 : Math.floor(raw);
	if (nonNegative > config.maxDurationMs) return {
		durationMs: config.maxDurationMs,
		clamped: true
	};
	return {
		durationMs: nonNegative,
		clamped: nonNegative !== raw
	};
}
/**
* Sleep for `durationMs`, resolving early with `cancelled: true` if `signal`
* aborts. The signal is never thrown through — cancellation is a normal
* business outcome reported in the canonical value (C5).
*
* A zero or negative `durationMs` resolves synchronously without scheduling
* a timer.
*/
function sleepWithCancellation(durationMs, signal) {
	if (durationMs <= 0) return Promise.resolve({
		cancelled: false,
		actualMs: 0
	});
	if (signal.aborted) return Promise.resolve({
		cancelled: true,
		actualMs: 0
	});
	const start = Date.now();
	return new Promise((resolve) => {
		const onAbort = () => {
			cleanup();
			resolve({
				cancelled: true,
				actualMs: Date.now() - start
			});
		};
		const onTimeout = () => {
			cleanup();
			resolve({
				cancelled: false,
				actualMs: Date.now() - start
			});
		};
		const timer = setTimeout(onTimeout, durationMs);
		function cleanup() {
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
		}
		signal.addEventListener("abort", onAbort, { once: true });
	});
}
function renderSleepOutput(value) {
	const lines = [`Slept ${value.actual_ms}ms (requested ${value.requested_ms}ms).`];
	if (value.clamped) lines.push("Duration was clamped to the configured maximum.");
	if (value.cancelled) lines.push("Sleep was cancelled by an abort signal before completing.");
	if (value.reason) lines.push(`Reason: ${value.reason}`);
	return lines.join("\n");
}
function textRender(fn) {
	return (_args, value) => [{
		type: "text",
		text: fn(value)
	}];
}
function registerTools(ctx, getConfig) {
	const config = () => getConfig();
	ctx.tools.register(defineTool({
		name: "sleep",
		description: "Pause execution for the given number of milliseconds, then return. Use this when you need to wait for a time-based condition to become true (e.g., a server restart, a debounce window, a retry backoff) and no event-based tool fits. The duration is bounded by the plugin's maxDurationMs config (default 60000ms); larger values are clamped. If the surrounding turn is cancelled while sleeping, the tool returns early with cancelled=true instead of throwing.",
		parameters: {
			duration_ms: {
				type: "integer",
				required: true,
				description: "Number of milliseconds to sleep. Must be >= 0. Values above the plugin's maxDurationMs are clamped to that maximum and the result reports clamped=true."
			},
			reason: {
				type: "string",
				description: "Optional human-readable explanation of why the sleep is needed."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					requested_ms: {
						type: "integer",
						required: true,
						description: "The duration originally requested by the caller."
					},
					actual_ms: {
						type: "integer",
						required: true,
						description: "Milliseconds actually spent sleeping (may be less than requested_ms on cancellation)."
					},
					cancelled: {
						type: "boolean",
						required: true,
						description: "True if the sleep was interrupted by an abort signal before completing."
					},
					clamped: {
						type: "boolean",
						description: "True if the requested duration exceeded the configured maximum and was clamped."
					},
					reason: {
						type: "string",
						description: "Echo of the caller-supplied reason, if any."
					}
				}
			},
			render: textRender(renderSleepOutput)
		},
		execute: async (args, exec) => {
			const a = args;
			const cfg = config();
			const requestedRaw = typeof a.duration_ms === "number" ? a.duration_ms : cfg.defaultDurationMs;
			const { durationMs, clamped } = resolveDuration(requestedRaw, cfg);
			const outcome = await sleepWithCancellation(durationMs, exec.signal);
			const result = {
				requested_ms: Math.floor(requestedRaw),
				actual_ms: outcome.actualMs,
				cancelled: outcome.cancelled,
				clamped
			};
			if (a.reason !== void 0 && a.reason !== "") result.reason = a.reason;
			return result;
		}
	}));
}
//#endregion
//#region src/index.ts
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
* @module @huanlin/dsh-plugin-sleep
*/
const name = "dsh-sleep";
const inject = ["tools"];
const Config = z.object({
	maxDurationMs: z.number().default(6e4).description("Maximum sleep duration in milliseconds. Larger requests are clamped to this value."),
	defaultDurationMs: z.number().default(0).description("Fallback duration when the model omits duration_ms. Defaults to 0.")
});
function resolveConfig(config) {
	const max = typeof config.maxDurationMs === "number" && config.maxDurationMs >= 0 ? config.maxDurationMs : 6e4;
	const def = typeof config.defaultDurationMs === "number" && config.defaultDurationMs >= 0 ? config.defaultDurationMs : 0;
	return {
		maxDurationMs: max,
		defaultDurationMs: Math.min(def, max)
	};
}
function apply(ctx, config = {}) {
	const resolved = resolveConfig(config);
	registerTools(ctx, () => resolved);
}
//#endregion
export { Config, apply, inject, name, resolveConfig };
