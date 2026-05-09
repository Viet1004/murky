/**
 * Helpers shared between the regret-prompt injection and the background
 * worker for shaping the trace + response payloads.
 */

export type RegretResponse = "fits" | "not_sure" | "regret" | "skipped";

export interface RegretContext {
  href: string;
  siteId: string;
  productKey: string;
  title: string | null;
  wasMasked: boolean;
  userBypassedMask: boolean;
  clickedAt: number;
  /** Sequence id from background — lets the server dedupe duplicate prompts. */
  traceId: string;
}

export interface RegretEvent {
  trace_id: string;
  product_key: string;
  site_id: string;
  title: string | null;
  was_masked: boolean;
  user_bypassed_mask: boolean;
  href_origin: string;
  clicked_at: number;
  responded_at: number;
  response: RegretResponse;
  dwell_ms: number;
}

export async function recordRegretResponse(
  ctx: RegretContext,
  response: RegretResponse
): Promise<void> {
  const respondedAt = Date.now();
  let originHost = "";
  try {
    originHost = new URL(ctx.href).origin;
  } catch {
    /* keep empty */
  }
  const event: RegretEvent = {
    trace_id: ctx.traceId,
    product_key: ctx.productKey,
    site_id: ctx.siteId,
    title: ctx.title,
    was_masked: ctx.wasMasked,
    user_bypassed_mask: ctx.userBypassedMask,
    href_origin: originHost,
    clicked_at: ctx.clickedAt,
    responded_at: respondedAt,
    response,
    dwell_ms: respondedAt - ctx.clickedAt,
  };
  // Forward to background — it owns the server URL + auth headers.
  await new Promise<void>((resolve) => {
    chrome.runtime.sendMessage(
      { type: "regret-response", event },
      () => resolve()
    );
  });
}
