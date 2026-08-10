import z from "schemastery";
import { Context } from "cordis";
//#region src/tools.d.ts
interface ResolvedConfig {
  maxDurationMs: number;
  defaultDurationMs: number;
}
//#endregion
//#region src/index.d.ts
declare const name = "dsh-sleep";
declare const inject: string[];
interface Config {
  maxDurationMs?: number;
  defaultDurationMs?: number;
}
declare const Config: z<Config>;
declare function resolveConfig(config: Config): ResolvedConfig;
declare function apply(ctx: Context, config?: Config): void;
//#endregion
export { Config, apply, inject, name, resolveConfig };