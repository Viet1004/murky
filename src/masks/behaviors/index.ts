/**
 * Behavior runtime for server-compiled masks.
 *
 * The server returns each mask as a chunk of HTML carrying a
 * `data-murky-behavior="<id>"` attribute on its outermost element. The
 * extension scans for that attribute and activates the named behavior from
 * this allowlist. Unknown ids → fall back to `static` (no interaction).
 *
 * Adding a behavior here:
 *   - Add an exported activator in its own file
 *   - Register it in BEHAVIORS below
 *   - Keep activator names stable; if you have to break a contract, ship a
 *     new id alongside the old one (e.g. "peel-stack" → "peel-stack-v2") so
 *     older server payloads still render.
 *
 * Versioning: this map is the extension's contract surface. Bumping
 * RENDERER_VERSION signals to telemetry which renderer mounted a given
 * mask — useful when chasing regressions after a behavior change.
 */
import { flipCardBehavior } from "./flipCard";
import { peelStackBehavior } from "./peelStack";
import { staticBehavior } from "./static";

/** Bump when the renderer wire contract (HTML attribute layout, etc.) changes. */
export const RENDERER_VERSION = 1;

export interface BehaviorHandle {
  /** Mark the mask as fully revealed; tears down the overlay. */
  reveal(): void;
  /** Record an interaction event for telemetry / behavioral analysis. */
  recordInteraction(label: string, payload?: unknown): void;
}

export type BehaviorActivator = (root: HTMLElement, handle: BehaviorHandle) => void;

export const BEHAVIORS: Record<string, BehaviorActivator> = {
  static: staticBehavior,
  "peel-stack": peelStackBehavior,
  "flip-card": flipCardBehavior,
};

export function activateBehavior(
  behaviorId: string,
  root: HTMLElement,
  handle: BehaviorHandle
): void {
  const activator = BEHAVIORS[behaviorId];
  if (!activator) {
    console.warn(
      `[murky] unknown behavior '${behaviorId}'; falling back to static. ` +
      `Renderer version ${RENDERER_VERSION} knows: ${Object.keys(BEHAVIORS).join(", ")}.`
    );
    staticBehavior(root, handle);
    return;
  }
  activator(root, handle);
}
