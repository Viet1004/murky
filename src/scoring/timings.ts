/**
 * Lightweight timing instrumentation for the scoring pipeline.
 *
 * Disabled by default. To enable in a browser tab where Murky runs:
 *
 *   localStorage.murkyDebugTimings = "1"
 *   // (then refresh the page)
 *
 * When enabled, each page scan logs an aggregated summary like:
 *
 *   [murky timing] page scan: 47 cards
 *     scrape   count=47   total=   18ms  p50=  0.4ms  p95=  1.2ms
 *     score    count=47   total= 1980ms  p50= 42.0ms  p95= 88.0ms
 *     embed    count=94   total= 1932ms  p50= 41.0ms  p95= 87.0ms
 *     cosine   count=47   total=    1ms  p50=  0.0ms  p95=  0.1ms
 *     mount    count=23   total=  108ms  p50=  4.1ms  p95=  6.0ms
 *     dominated by: score (91% of measured time)
 *
 * Use this to find the real bottleneck before deciding which
 * optimization (cache / mask-first / quantization / Web Worker) to ship.
 */

export interface TimingSummary {
  count: number;
  total: number;
  p50: number;
  p95: number;
  p99: number;
}

class Timings {
  private samples = new Map<string, number[]>();
  private enabledCached: boolean | null = null;

  /**
   * Cached for the lifetime of the page. The flag is set rarely (a
   * developer toggling debug) so caching is fine and avoids paying
   * localStorage cost on every measure() call.
   */
  isEnabled(): boolean {
    if (this.enabledCached !== null) return this.enabledCached;
    try {
      this.enabledCached = localStorage.getItem("murkyDebugTimings") === "1";
    } catch {
      // SW context or sandboxed page — localStorage not available.
      this.enabledCached = false;
    }
    return this.enabledCached;
  }

  add(label: string, ms: number): void {
    if (!this.isEnabled()) return;
    let arr = this.samples.get(label);
    if (!arr) {
      arr = [];
      this.samples.set(label, arr);
    }
    arr.push(ms);
  }

  /** Time an async operation and record the elapsed milliseconds. */
  async measure<T>(label: string, fn: () => Promise<T>): Promise<T> {
    if (!this.isEnabled()) return fn();
    const t0 = performance.now();
    try {
      return await fn();
    } finally {
      this.add(label, performance.now() - t0);
    }
  }

  /** Time a sync operation. */
  measureSync<T>(label: string, fn: () => T): T {
    if (!this.isEnabled()) return fn();
    const t0 = performance.now();
    try {
      return fn();
    } finally {
      this.add(label, performance.now() - t0);
    }
  }

  summary(label: string): TimingSummary | null {
    const arr = this.samples.get(label);
    if (!arr || arr.length === 0) return null;
    const sorted = [...arr].sort((a, b) => a - b);
    const p = (frac: number) =>
      sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * frac))];
    return {
      count: arr.length,
      total: arr.reduce((s, v) => s + v, 0),
      p50: p(0.5),
      p95: p(0.95),
      p99: p(0.99),
    };
  }

  /** Emit a one-line summary per recorded label, then clear the buffer. */
  flush(group: string): void {
    if (!this.isEnabled() || this.samples.size === 0) return;
    const lines = [`[murky timing] ${group}`];
    let dominantTotal = 0;
    let dominantLabel = "";
    let grandTotal = 0;
    // Keep insertion order so callers can rely on the first label being
    // the broadest scope (e.g. "score" wraps "embed" + "cosine").
    for (const label of this.samples.keys()) {
      const s = this.summary(label);
      if (!s) continue;
      lines.push(
        `  ${label.padEnd(8)} count=${String(s.count).padStart(4)}  ` +
          `total=${s.total.toFixed(0).padStart(5)}ms  ` +
          `p50=${s.p50.toFixed(1).padStart(5)}ms  ` +
          `p95=${s.p95.toFixed(1).padStart(5)}ms`
      );
      grandTotal += s.total;
      if (s.total > dominantTotal) {
        dominantTotal = s.total;
        dominantLabel = label;
      }
    }
    if (grandTotal > 0 && dominantLabel) {
      const pct = ((100 * dominantTotal) / grandTotal).toFixed(0);
      lines.push(
        `  dominated by: ${dominantLabel} (${pct}% of measured time)`
      );
    }
    console.log(lines.join("\n"));
    this.samples.clear();
  }
}

export const timings = new Timings();
