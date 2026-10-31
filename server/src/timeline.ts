/**
 * Server-side delayed events, our counterpart of rAthena's add_timer(tick + delay, func, ...) (src/common/timer.cpp) for
 * things that happen a fixed time after an action: delayed normal-attack damage (battle_delay_damage), the mob_attacked
 * retaliation after the walk delay, and later skill hits / cast ends. The room drains it at the start of every simulation
 * tick; events run in due-time order (ties in insertion order) and get their own due time, so follow-up events can be
 * scheduled relative to the exact moment rather than to the 50 ms tick that happened to run them.
 *
 * Handlers must re-validate the world themselves (the unit may have died, left or moved) — like rAthena timer functions,
 * which look units up again by id instead of holding pointers.
 */
type Event = { at: number; seq: number; run: (at: number) => void };

export class Timeline {
  private q: Event[] = []; // sorted by (at, seq)
  private seq = 0;

  /** Schedule `run` at time `at` (room clock ms). */
  add(at: number, run: (at: number) => void) {
    const e = { at, seq: this.seq++, run };
    let lo = 0, hi = this.q.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.q[mid].at <= at) lo = mid + 1; else hi = mid; }
    this.q.splice(lo, 0, e);
  }

  /** Run every event due at or before `now`, oldest first. Events added while draining that are already due run in this pass. */
  run(now: number) {
    while (this.q.length && this.q[0].at <= now) {
      const e = this.q.shift()!;
      try { e.run(e.at); } catch (err) { console.error("[timeline]", err); }
    }
  }

  get size() { return this.q.length; }
}
