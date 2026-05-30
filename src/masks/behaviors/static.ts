import type { BehaviorActivator } from "./index";

/**
 * No-op activator for masks that don't have interactive behavior
 * (e.g. quote, html-snippet displayed as static decoration).
 *
 * Why a real function exists for "nothing happens": the renderer dispatches
 * by behavior id and we want unknown ids to fall back to *something*
 * deterministic. `static` is also the documented behavior for compilers that
 * emit purely visual masks, so it has a stable home here.
 */
export const staticBehavior: BehaviorActivator = (_root, _handle) => {
  // intentionally empty
};
