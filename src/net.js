// Addresses (07 §7.8, §7.11): who a request comes from, and which addresses are this machine or
// its network.
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { hostname, networkInterfaces } from 'node:os';
import { Readable } from 'node:stream';

// An address written one way only, so two spellings of it compare equal: no brackets, lowercase,
// IPv6 in its shortest form (as URLs write it), and IPv4-mapped IPv6 as plain IPv4:
// "::ffff:192.168.1.5", "::ffff:c0a8:105" and "0:0:0:0:0:ffff:c0a8:105" are all 192.168.1.5.
// Anything that isn't an address comes back trimmed and lowercased.
export function normalizeIp(addr) {
  const a = String(addr || '').trim().replace(/^\[(.*)\]$/, '$1').toLowerCase();
  if (isIP(a) !== 6) return a;
  const [base, zone] = a.split('%'); // a link-local address's zone ("fe80::1%eth0"), which URLs don't take
  let short;
  try { short = new URL(`http://[${base}]/`).hostname.slice(1, -1); } catch { return a; }
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(short);
  if (mapped) {
    const hi = parseInt(mapped[1], 16);
    const lo = parseInt(mapped[2], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return zone === undefined ? short : `${short}%${zone}`;
}

export const isLoopback = (addr) => {
  const a = normalizeIp(addr);
  return a === '::1' || (isIP(a) === 4 && a.startsWith('127.'));
};

// This machine, the local network, link-local (cloud metadata), carrier-grade NAT (where VPNs
// such as Tailscale live) and other non-public ranges. Of 192.0.0.0/16 only 192.0.0.0/24 and
// 192.0.2.0/24 (TEST-NET-1): the rest is public (ICANN, WordPress.com).
export function isPrivateAddress(ip) {
  const addr = normalizeIp(ip);
  if (isIP(addr) === 4) {
    const [a, b, c] = addr.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  // "::" first: unspecified, loopback, and the reserved rest of ::/16 (IPv4-compatible "::7f00:1").
  return addr.startsWith('::') || /^f[cd]/.test(addr) || /^fe[89ab]/.test(addr) || addr.startsWith('ff') || addr.startsWith('64:ff9b:');
}

// Headers a proxy adds to what it forwards.
export const FORWARDING =['x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'forwarded', 'x-real-ip', 'via'];

// An X-Forwarded-For entry's address. Some proxies (IIS ARR, Azure Application Gateway) add the
// client's port: "203.0.113.9:5555", "[2001:db8::1]:5555". An entry that isn't an address is
// "unknown", never skipped: skipping it would make the entry before it, which the client may
// have written itself, the client's address.
const forwardedIp = (entry) => {
  const s = String(entry).trim();
  const m = /^\[([^\]]+)\](?::\d+)?$/.exec(s) || /^(\d+\.\d+\.\d+\.\d+):\d+$/.exec(s);
  const ip = normalizeIp(m ? m[1] : s);
  return isIP(ip) ? ip : 'unknown';
};

// Who a request comes from: { ip, https, proxied }. The socket's address and whether it is TLS,
// or, when the socket is a trusted proxy (SKP_TRUST_PROXY) forwarding a request, what the proxy
// says: the client in X-Forwarded-For, read from the right past any trusted proxies, and
// X-Forwarded-Proto. X-Forwarded-* from anyone else is ignored (07 §7.8). A request from the
// proxy's address that forwards nothing is the proxy's machine's own: the command line beside a
// local reverse proxy, say. One it forwards without naming the client (no X-Forwarded-For, or an
// empty one) is from "unknown", never the proxy's own address: that would make anyone on the
// internet local to setup, lan mode, the per-IP limits and a token's address list. trustProxy:
// addresses as normalizeIp writes them (config.js).
export function clientOf(req, trustProxy = []) {
  const peer = normalizeIp(req.socket?.remoteAddress);
  const tls = Boolean(req.socket?.encrypted);
  if (!trustProxy.includes(peer) || !FORWARDING.some((h) => req.headers[h] !== undefined)) return { ip: peer, https: tls, proxied: false };
  const chain = String(req.headers['x-forwarded-for'] || '').split(',').filter((e) => e.trim() !== '').map(forwardedIp);
  let ip = 'unknown';
  for (let i = chain.length - 1; i >= 0; i--) {
    ip = chain[i];
    if (!trustProxy.includes(chain[i])) break;
  }
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  return { ip, https: proto ? proto === 'https' : tls, proxied: true, ...(chain.length ? {} : { unnamed: true }) };
}

// A fetch for downloads the platform makes on someone's behalf (07 §7.11): https only, and the
// address it connects to is the one it checked, in the same lookup (a DNS-rebinding host can't
// answer a public address to a check and a private one to the connection). lookup(host) resolves
// to [{ address, family }]; allowPrivate is the owner's SKP_ALLOW_PRIVATE_DOWNLOADS; tls: more TLS
// options (tests: a self-signed certificate).
// The answer is a WHATWG Response, like fetch's; redirects are not followed (the caller checks
// each hop).
export function pinnedFetch({ lookup, allowPrivate = false, tls = {} } = {}) {
  return (url, { headers = {}, signal } = {}) => new Promise((resolve, reject) => {
    const target = new URL(url);
    if (target.protocol !== 'https:') return reject(new TypeError(`only https downloads (${target.protocol})`));
    // An address in the URL is connected to as it is, with no lookup: check it here.
    const literal = target.hostname.replace(/^\[(.*)\]$/, '$1');
    if (!allowPrivate && isIP(literal) && isPrivateAddress(literal)) {
      const err = new Error(`${literal} is a private or local address`);
      err.code = 'EPRIVATE';
      return reject(err);
    }
    const connectLookup = (hostname, options, callback) => {
      lookup(hostname).then((addresses) => {
        const list = addresses.filter((a) => allowPrivate || !isPrivateAddress(a.address));
        if (!list.length) {
          const err = new Error(`${hostname} resolves to a private or local address (${addresses[0]?.address ?? 'none'})`);
          err.code = 'EPRIVATE';
          return callback(err);
        }
        if (options?.all) return callback(null, list.map((a) => ({ address: a.address, family: a.family })));
        return callback(null, list[0].address, list[0].family);
      }, callback);
    };
    const req = httpsRequest(target, { ...tls, method: 'GET', headers, signal, lookup: connectLookup }, (res) => {
      const headerList = [];
      for (const [k, v] of Object.entries(res.headers)) headerList.push([k, Array.isArray(v) ? v.join(', ') : String(v)]);
      const empty = [101, 204, 205, 304].includes(res.statusCode);
      if (empty) res.resume();
      resolve(new Response(empty ? null : Readable.toWeb(res), { status: res.statusCode, headers: headerList }));
    });
    req.on('error', reject);
    req.end();
  });
}

// The names this machine answers to on its network, for the Host check in lan and public modes:
// its addresses (bracketed for IPv6) and its host name (and name.local). interfaces and host:
// test hooks, what os.networkInterfaces() and os.hostname() would answer.
export function machineNames({ interfaces = networkInterfaces, host = hostname } = {}) {
  const names = new Set();
  try {
    for (const list of Object.values(interfaces())) {
      for (const a of list || []) names.add(a.family === 'IPv6' || a.family === 6 ? `[${a.address.split('%')[0].toLowerCase()}]` : a.address);
    }
  } catch { /* no interfaces to read */ }
  try {
    const h = host().toLowerCase();
    if (h) {
      names.add(h);
      if (!h.includes('.')) names.add(`${h}.local`);
    }
  } catch { /* no host name */ }
  return [...names];
}

// machineNames kept up to date: a laptop's Wi-Fi address can arrive or change after the platform
// started. names(host) answers from what was last read, and reads again when that is older than
// maxAgeMs, or when a request's Host (host[:port]) isn't among them and the last read is at least
// a second old (a stream of made-up Hosts reads at most once a second).
export function liveMachineNames({ read = machineNames, now = Date.now, maxAgeMs = 5000 } = {}) {
  let names = read();
  let at = now();
  return (host) => {
    const age = now() - at;
    const wanted = host === undefined ? undefined : String(host).toLowerCase().replace(/:\d+$/, '');
    if (age < 0 || age >= maxAgeMs || (wanted !== undefined && age >= 1000 && !names.includes(wanted))) {
      names = read();
      at = now();
    }
    return names;
  };
}
