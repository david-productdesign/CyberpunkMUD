import { FAILURE_WINDOW_MS, ACCOUNT_WINDOW_MS } from '../net/limits.js';

// Counts events per key over a sliding window: how many wrong passphrases from
// this address in the last 15 minutes, and so on.
export function createWindowCounter(windowMs, now = Date.now) {
  const events = new Map(); // key -> timestamps, oldest first

  function recent(key) {
    const cutoff = now() - windowMs;
    const kept = (events.get(key) ?? []).filter((time) => time > cutoff);
    if (kept.length === 0) events.delete(key);
    else events.set(key, kept);
    return kept;
  }

  // Keys are only pruned when looked at, so addresses that never come back
  // would otherwise stay in memory for good.
  const sweeper = setInterval(() => {
    for (const key of events.keys()) recent(key);
  }, windowMs);
  sweeper.unref();

  return {
    count: (key) => recent(key).length,
    add(key) {
      const kept = recent(key);
      kept.push(now());
      events.set(key, kept);
    },
  };
}

export function createThrottles() {
  return {
    loginFailuresByIp: createWindowCounter(FAILURE_WINDOW_MS),
    loginFailuresByHandle: createWindowCounter(FAILURE_WINDOW_MS),
    accountsByIp: createWindowCounter(ACCOUNT_WINDOW_MS),
  };
}
