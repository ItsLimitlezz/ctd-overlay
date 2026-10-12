// Addresses (07 §7.8, §7.11): who a request comes from, and which addresses are this machine or
// its network.
import { isIP } from 'node:net';
import { hostname, networkInterfaces } from 'node:os';

// "::ffff:192.168.1.5" is 192.168.1.5.
export const normalizeIp = (addr) => String(addr || '').trim().replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i, '$1').replace(/^\[|\]$/g, '').toLowerCase();

export const isLoopback = (addr) => {
  const a = normalizeIp(addr);
  return a === '::1' || (isIP(a) === 4 && a.startsWith('127.'));
};

// This machine, the local network, link-local (cloud metadata), carrier-grade NAT (where VPNs
// such as Tailscale live) and other non-public ranges.
export function isPrivateAddress(ip) {
  const v4 = (s) => {
    const [a, b] = s.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0)) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  };
  if (isIP(ip) === 4) return v4(ip);
  const v6 = String(ip).toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  if (mapped) return v4(mapped[1]);
  return v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith('ff') || v6.startsWith('64:ff9b:');
}

// Who a request comes from: { ip, https, proxied }. The socket's address and whether it is TLS,
// or, when the socket is a trusted proxy (SKP_TRUST_PROXY), what the proxy says: the client in
// X-Forwarded-For, read from the right past any trusted proxies, and X-Forwarded-Proto. X-Forwarded-*
// from anyone else is ignored (07 §7.8).
export function clientOf(req, trustProxy = []) {
  const peer = normalizeIp(req.socket?.remoteAddress);
  const tls = Boolean(req.socket?.encrypted);
  if (!trustProxy.length || !trustProxy.includes(peer)) return { ip: peer, https: tls, proxied: false };
  const chain = String(req.headers['x-forwarded-for'] || '').split(',').map(normalizeIp).filter((a) => isIP(a));
  let ip = peer;
  for (let i = chain.length - 1; i >= 0; i--) {
    ip = chain[i];
    if (!trustProxy.includes(chain[i])) break;
  }
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  return { ip, https: proto ? proto === 'https' : tls, proxied: true };
}

// The names this machine answers to on its network, for the Host check in lan and public modes:
// its addresses (bracketed for IPv6) and its host name (and name.local).
export function machineNames() {
  const names = new Set();
  try {
    for (const list of Object.values(networkInterfaces())) {
      for (const a of list || []) names.add(a.family === 'IPv6' || a.family === 6 ? `[${a.address.split('%')[0].toLowerCase()}]` : a.address);
    }
  } catch { /* no interfaces to read */ }
  try {
    const h = hostname().toLowerCase();
    if (h) {
      names.add(h);
      if (!h.includes('.')) names.add(`${h}.local`);
    }
  } catch { /* no host name */ }
  return [...names];
}
