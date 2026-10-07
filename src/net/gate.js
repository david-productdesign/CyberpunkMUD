// Counts open connections, overall and per address, so no one address and no
// flood of them can take every slot.

export function createGate({ maxConnections, maxConnectionsPerIp }) {
  const perIp = new Map();
  let total = 0;

  return {
    // Returns why the connection is refused, or null and counts it as open.
    admit(ip) {
      if (total >= maxConnections) return 'server full';
      const fromIp = perIp.get(ip) ?? 0;
      if (fromIp >= maxConnectionsPerIp) return 'too many connections from this address';
      perIp.set(ip, fromIp + 1);
      total += 1;
      return null;
    },

    release(ip) {
      const fromIp = perIp.get(ip) ?? 0;
      if (fromIp <= 1) perIp.delete(ip);
      else perIp.set(ip, fromIp - 1);
      total -= 1;
    },
  };
}

// An IPv4 client on a dual-stack socket shows up as ::ffff:203.0.113.5. Logs
// and limits should see the address people recognise.
export function normaliseIp(address = 'unknown') {
  return address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
}
