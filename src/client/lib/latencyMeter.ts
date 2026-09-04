// Measures the wall-clock time from the first motion detection to a still request, which is the
// full "dart landed → score appeared → frontend asked for evidence" round trip as seen by the
// scoring device. Only a dev-mode experiment — every method is a no-op in production.
//
// State machine:
//
//   IDLE
//     │ motion.dot: idle → pending
//     ▼
//   WAITING_FOR_TIPS   [startTime captured]
//     │
//     ├─ tips with darts     →  WAITING_FOR_STILL
//     ├─ tips empty          →  cancel
//     ├─ motion re-detected  →  abandon
//     └─ timeout 3000ms      →  cancel
//     │
//     ▼
//   WAITING_FOR_STILL
//     │
//     ├─ still request arrives →  RECORD → IDLE
//     ├─ motion re-detected    →  abandon
//     └─ timeout 3000ms        →  cancel

type State = 'idle' | 'waiting_for_tips' | 'waiting_for_still';

const MAX_MEASUREMENTS = 200;
const SAFETY_TIMEOUT_MS = 3000;

export interface LatencySnapshot {
  min: number | null;
  max: number | null;
  avg: number | null;
  last: number | null;
  count: number;
}

export class LatencyMeter {
  private state: State = 'idle';
  private startTime = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private measurements: number[] = [];

  /** Only active in dev builds. Kept as a field so the guard is read once. */
  private readonly active: boolean;

  constructor() {
    this.active = import.meta.env.DEV;
  }

  // ── public API (all no-op in prod) ──────────────────────────────

  /** The motion detector just saw its first change after being idle. */
  onMotionDetected(): void {
    if (!this.active) return;
    // If we're already measuring (e.g. motion re-triggered before tips), abandon.
    if (this.state !== 'idle') {
      this.abandon();
      return;
    }
    this.state = 'waiting_for_tips';
    this.startTime = performance.now();
    this.scheduleTimeout();
  }

  /**
   * An inference produced tips (or an empty array).
   *
   * `hasDarts` is true when `tips.length > 0`, false for the takeout signal.
   * A frame that didn't solve a homography never calls this — its tips are
   * not published at all, so the safety timeout covers it.
   */
  onTipsReceived(hasDarts: boolean): void {
    if (!this.active) return;
    if (this.state !== 'waiting_for_tips') return;
    if (!hasDarts) {
      this.cancel();
      return;
    }
    this.state = 'waiting_for_still';
    this.scheduleTimeout();
  }

  /** A still request arrived via the media mesh — the measurement is complete. */
  onStillRequested(): void {
    if (!this.active) return;
    if (this.state !== 'waiting_for_still') return;
    this.record();
  }

  /** Motion was detected while a measurement was already in flight. Abandon both. */
  onMotionReDetected(): void {
    if (!this.active) return;
    if (this.state === 'idle') return;
    this.abandon();
  }

  /** Current min / max / avg / last / count, for rendering. */
  snapshot(): LatencySnapshot {
    if (this.measurements.length === 0) {
      return { min: null, max: null, avg: null, last: null, count: 0 };
    }
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    for (const m of this.measurements) {
      if (m < min) min = m;
      if (m > max) max = m;
      sum += m;
    }
    return {
      min,
      max,
      avg: Math.round(sum / this.measurements.length),
      last: this.measurements[this.measurements.length - 1],
      count: this.measurements.length,
    };
  }

  // ── internals ──────────────────────────────────────────────────

  private record(): void {
    this.measurements.push(Math.round(performance.now() - this.startTime));
    if (this.measurements.length > MAX_MEASUREMENTS) this.measurements.shift();
    this.reset();
  }

  private cancel(): void {
    this.reset();
  }

  private abandon(): void {
    this.reset();
  }

  private reset(): void {
    this.state = 'idle';
    this.clearTimer();
  }

  private scheduleTimeout(): void {
    this.clearTimer();
    this.timer = setTimeout(() => this.cancel(), SAFETY_TIMEOUT_MS);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
