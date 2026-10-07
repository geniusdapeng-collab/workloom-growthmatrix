/** Per-run planning settings for the shared vendor prototypes. */
import { AsyncLocalStorage } from "node:async_hooks";
import { durationPolicy, type DurationPolicy } from "./creative-duration-policy.js";
import type { DurationProjectionEvent } from "./vendor-compat.js";

export interface DurationRunContext {
  policy: DurationPolicy;
  minSingleShotSeconds: number;
  maxSingleShotSeconds: number;
  onEvent?: (event: DurationProjectionEvent) => void;
  log?: (line: string) => void;
}
const contexts = new AsyncLocalStorage<Readonly<DurationRunContext>>();

export function withDurationRunContext<T>(settings: DurationRunContext, work: () => T): T {
  const { minSingleShotSeconds: min, maxSingleShotSeconds: max } = settings;
  if (!Number.isInteger(min) || !Number.isInteger(max) || min <= 0 || max < min) {
    throw new Error("DURATION_RUN_BOUNDS_INVALID: positive integer planning bounds required");
  }
  return contexts.run(Object.freeze({ ...settings, policy: durationPolicy(settings.policy) }), work);
}

export function currentDurationRunContext(): Readonly<DurationRunContext> | undefined {
  return contexts.getStore();
}
