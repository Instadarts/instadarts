// Throw windows across n cameras, ported from dartszentrale-ai-scorer server/throw-window.ts.
//
// Two cameras looking at the same board see the same throw a few tens of milliseconds apart, and
// they must produce one set of darts rather than two. So a report does not go straight to the
// tracker: it opens a short window, and whatever else arrives inside it is fused together.
//
// Everything is timed at arrival on the server, so the devices never need agreeing clocks.
//
// A window closes on whichever comes first:
//   · every expected camera has reported — the common case, and the fast one;
//   · an adaptive timeout: the slowest camera's p75 arrival latency plus a buffer, capped.
//
// With one camera the first condition fires on the first report, so a single-camera setup pays no
// latency at all for this.

import type { BoardTip } from '../../shared/vision/types';

/** Hard ceiling on how long a window may stay open. */
export const THROW_WINDOW_MAX_MS = 750;
/** Added to the observed p75 so a camera that is merely typical is not cut off. */
export const THROW_WINDOW_LATENCY_BUFFER_MS = 200;
/** How many arrivals per camera the latency estimate remembers. */
export const LATENCY_WINDOW_SIZE = 10;

export interface TipReport {
  deviceId: string;
  tips: BoardTip[];
}

export type CloseReason = 'all-cameras' | 'adaptive-timeout' | 'max-window';

export interface WindowResult {
  reports: TipReport[];
  reason: CloseReason;
  elapsedMs: number;
  expected: number;
}

interface Options {
  /** How many cameras this session currently expects tips from. */
  expectedCameras: () => number;
  onClose: (result: WindowResult) => void;
}

export class ThrowWindows {
  private readonly opts: Options;
  /** Per camera, the last few arrival delays relative to the window that was already open. */
  private readonly latencies = new Map<string, number[]>();
  private open: {
    /** Keyed by device: a camera that reports twice inside one window replaces its own report. */
    buffer: Map<string, TipReport>;
    timer: ReturnType<typeof setTimeout>;
    openedAt: number;
    reason: CloseReason;
  } | null = null;

  constructor(opts: Options) {
    this.opts = opts;
  }

  stop(): void {
    if (this.open) clearTimeout(this.open.timer);
    this.open = null;
  }

  /** One inference's worth of tips from one camera, timed as it arrives here. */
  add(report: TipReport): void {
    const now = Date.now();
    if (!this.open) {
      const timeout = this.timeout();
      const reason: CloseReason = timeout >= THROW_WINDOW_MAX_MS ? 'max-window' : 'adaptive-timeout';
      this.open = {
        buffer: new Map([[report.deviceId, report]]),
        timer: setTimeout(() => this.close(reason), timeout),
        openedAt: now,
        reason,
      };
    } else {
      // How late this camera was relative to the one that opened the window — the only difference
      // the timeout has to cover.
      this.record(report.deviceId, now - this.open.openedAt);
      this.open.buffer.set(report.deviceId, report);
    }
    this.closeIfComplete();
  }

  /**
   * The expected-camera count changed. A window waiting on a camera that has just stopped, slept or
   * dropped its socket would otherwise sit open until the cap, so it is re-checked immediately.
   */
  recount(): void {
    this.closeIfComplete();
  }

  /** A camera that has gone for good should stop dragging the adaptive timeout up. */
  forget(deviceId: string): void {
    this.latencies.delete(deviceId);
  }

  private closeIfComplete(): void {
    if (!this.open) return;
    if (this.open.buffer.size < Math.max(1, this.opts.expectedCameras())) return;
    clearTimeout(this.open.timer);
    this.close('all-cameras');
  }

  private close(reason: CloseReason): void {
    if (!this.open) return;
    const { buffer, openedAt } = this.open;
    this.open = null;
    this.opts.onClose({
      reports: [...buffer.values()],
      reason,
      elapsedMs: Date.now() - openedAt,
      expected: Math.max(1, this.opts.expectedCameras()),
    });
  }

  private record(deviceId: string, delayMs: number): void {
    const history = this.latencies.get(deviceId) ?? [];
    history.push(delayMs);
    if (history.length > LATENCY_WINDOW_SIZE) history.shift();
    this.latencies.set(deviceId, history);
  }

  /**
   * How long to hold a window open: the slowest camera's p75 arrival delay plus a buffer, capped.
   *
   * p75 rather than the max, because one pathological frame should not slow every throw afterwards;
   * the cap is what covers the tail. With no history yet there is nothing to estimate from, so the
   * cap is the honest answer.
   */
  private timeout(): number {
    let maxP75 = 0;
    for (const history of this.latencies.values()) {
      if (!history.length) continue;
      const sorted = [...history].sort((a, b) => a - b);
      const p75 = sorted[Math.floor(sorted.length * 0.75)] ?? 0;
      if (p75 > maxP75) maxP75 = p75;
    }
    if (maxP75 === 0) return THROW_WINDOW_MAX_MS;
    return Math.min(THROW_WINDOW_MAX_MS, maxP75 + THROW_WINDOW_LATENCY_BUFFER_MS);
  }
}
