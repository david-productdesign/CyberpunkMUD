// A token bucket: `capacity` actions back to back, then `perSecond` after that.

export function createBucket({ capacity, perSecond, now = Date.now }) {
  let tokens = capacity;
  let refilledAt = now();

  function refill() {
    const current = now();
    tokens = Math.min(capacity, tokens + ((current - refilledAt) / 1000) * perSecond);
    refilledAt = current;
  }

  return {
    take() {
      refill();
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },
  };
}
