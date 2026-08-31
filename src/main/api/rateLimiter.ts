/**
 * P2.1 — token bucket driven by Riot's own headers.
 *
 * A personal key allows 20 requests/second and 100 per 120 seconds. Ten accounts at three or
 * four calls each is comfortably inside that, but the limits are per-key and shared with
 * anything else the user runs, so the budget is not ours alone.
 *
 * The limits are PARSED from `x-app-rate-limit` rather than hardcoded (RESEARCH §9). Hardcoding
 * means a key upgrade goes unnoticed and, worse, a limit reduction gets discovered as a wall of
 * 429s. The headers also carry current usage, so after the first response the limiter knows the
 * real remaining budget instead of only what it has spent itself.
 */

export interface RateWindow {
  /** Window length in seconds, e.g. 120. */
  seconds: number;
  /** Requests permitted in that window. */
  limit: number;
}

/** Parse `100:120,20:1` into windows. */
export function parseRateLimitHeader(header: string | undefined): RateWindow[] {
  if (!header) return [];
  return header
    .split(",")
    .map((part) => {
      const [limit, seconds] = part.trim().split(":").map(Number);
      return { limit: limit ?? 0, seconds: seconds ?? 0 };
    })
    .filter((w) => w.limit > 0 && w.seconds > 0);
}

const DEFAULT_WINDOWS: RateWindow[] = [
  { limit: 20, seconds: 1 },
  { limit: 100, seconds: 120 },
];

export class RateLimiter {
  private windows: RateWindow[] = DEFAULT_WINDOWS;
  /** Timestamps of requests we have made, newest last. */
  private history: number[] = [];
  /** Set when a 429 told us to wait; nothing is sent before this moment. */
  private blockedUntil = 0;
  /** Usage the server reported, which may exceed ours if another client shares the key. */
  private serverCounts = new Map<number, number>();

  /** Adopt the limits the server just told us about. */
  observeHeaders(headers: Record<string, string | string[] | undefined>): void {
    const limitHeader = header(headers, "x-app-rate-limit");
    const parsed = parseRateLimitHeader(limitHeader);
    if (parsed.length > 0) this.windows = parsed;

    const countHeader = header(headers, "x-app-rate-limit-count");
    for (const w of parseRateLimitHeader(countHeader)) {
      // In the count header the "limit" position holds current usage for that window.
      this.serverCounts.set(w.seconds, w.limit);
    }
  }

  /** Honour a 429. `retry-after` is in seconds. */
  observe429(headers: Record<string, string | string[] | undefined>): number {
    const retryAfter = Number(header(headers, "retry-after") ?? "1");
    const waitMs = Math.max(1000, (Number.isFinite(retryAfter) ? retryAfter : 1) * 1000);
    this.blockedUntil = Math.max(this.blockedUntil, Date.now() + waitMs);
    return waitMs;
  }

  /** How long to wait before the next request may go out. */
  private delayMs(): number {
    const now = Date.now();
    let wait = Math.max(0, this.blockedUntil - now);

    const longest = Math.max(...this.windows.map((w) => w.seconds), 1) * 1000;
    this.history = this.history.filter((t) => now - t < longest);

    for (const w of this.windows) {
      const windowMs = w.seconds * 1000;
      const mine = this.history.filter((t) => now - t < windowMs).length;
      // Trust the server's count when it is higher — another process may share this key.
      const used = Math.max(mine, this.serverCounts.get(w.seconds) ?? 0);
      if (used >= w.limit) {
        const oldest = this.history.find((t) => now - t < windowMs);
        // If the server says we are full but we have no history, wait out the whole window.
        wait = Math.max(wait, oldest === undefined ? windowMs : oldest + windowMs - now);
      }
    }

    return wait;
  }

  /** Wait until a request may be sent, then record that it was. */
  async acquire(): Promise<void> {
    for (;;) {
      const wait = this.delayMs();
      if (wait <= 0) break;
      await new Promise((r) => setTimeout(r, Math.min(wait, 5000)));
    }
    this.history.push(Date.now());
  }

  /** For the UI and diagnostics. */
  snapshot(): { windows: RateWindow[]; used: Array<{ seconds: number; used: number; limit: number }>; blockedForMs: number } {
    const now = Date.now();
    return {
      windows: this.windows,
      used: this.windows.map((w) => ({
        seconds: w.seconds,
        used: Math.max(
          this.history.filter((t) => now - t < w.seconds * 1000).length,
          this.serverCounts.get(w.seconds) ?? 0
        ),
        limit: w.limit,
      })),
      blockedForMs: Math.max(0, this.blockedUntil - now),
    };
  }

  reset(): void {
    this.history = [];
    this.blockedUntil = 0;
    this.serverCounts.clear();
    this.windows = DEFAULT_WINDOWS;
  }
}

function header(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}
