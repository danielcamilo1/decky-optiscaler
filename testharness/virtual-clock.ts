import { act } from "react";

interface TimerEntry {
  id: number;
  callback: () => void;
  time: number;
  interval: number | null;
  cancelled: boolean;
}

/**
 * Deterministic virtual clock for window.setTimeout / window.setInterval.
 *
 * Production code in src/ schedules all debounce, polling, and timeout timers
 * via window.setTimeout / window.setInterval, whereas Node's global setTimeout
 * remains real so React act() and promise microtasks settle cleanly in ~0ms.
 */
export function installVirtualClock() {
  const realSetTimeout = globalThis.setTimeout.bind(globalThis);
  const origWinSetTimeout = window.setTimeout;
  const origWinClearTimeout = window.clearTimeout;
  const origWinSetInterval = window.setInterval;
  const origWinClearInterval = window.clearInterval;

  let now = 0;
  let nextId = 1;
  const timers = new Map<number, TimerEntry>();

  const schedule = (cb: TimerHandler, delay?: number, interval: number | null = null): number => {
    const id = nextId++;
    const ms = Math.max(0, Number(delay) || 0);
    const fn = typeof cb === "function" ? (cb as () => void) : () => {};
    timers.set(id, { id, callback: fn, time: now + ms, interval, cancelled: false });
    return id;
  };

  const cancel = (id?: number) => {
    if (id == null) return;
    const entry = timers.get(id);
    if (entry) {
      entry.cancelled = true;
      timers.delete(id);
    }
  };

  window.setTimeout = ((cb: TimerHandler, delay?: number) =>
    schedule(cb, delay, null)) as typeof window.setTimeout;
  window.clearTimeout = cancel as typeof window.clearTimeout;
  window.setInterval = ((cb: TimerHandler, delay?: number) => {
    const period = Math.max(1, Number(delay) || 1);
    return schedule(cb, period, period);
  }) as typeof window.setInterval;
  window.clearInterval = cancel as typeof window.clearInterval;

  const flushMicrotasks = async (rounds = 4) => {
    for (let i = 0; i < rounds; i++) {
      await act(async () => {
        await new Promise<void>((resolve) => realSetTimeout(resolve, 0));
      });
    }
  };

  const advance = async (ms: number, maxSteps = 200) => {
    const target = now + Math.max(0, ms);
    let steps = 0;
    await flushMicrotasks(2);
    while (steps < maxSteps) {
      let next: TimerEntry | null = null;
      for (const entry of timers.values()) {
        if (entry.cancelled || entry.time > target) continue;
        if (!next || entry.time < next.time || (entry.time === next.time && entry.id < next.id)) {
          next = entry;
        }
      }
      if (!next) break;
      steps++;
      now = next.time;
      if (next.interval !== null) {
        next.time = now + next.interval;
      } else {
        timers.delete(next.id);
      }
      await act(async () => {
        next.callback();
        await Promise.resolve();
      });
      await flushMicrotasks(2);
    }
    now = target;
    await flushMicrotasks(3);
  };

  const restore = () => {
    timers.clear();
    window.setTimeout = origWinSetTimeout;
    window.clearTimeout = origWinClearTimeout;
    window.setInterval = origWinSetInterval;
    window.clearInterval = origWinClearInterval;
  };

  return {
    advance,
    flushMicrotasks,
    restore,
    get now() {
      return now;
    },
  };
}
