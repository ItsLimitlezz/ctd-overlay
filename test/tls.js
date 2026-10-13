// A self-signed certificate for tests, made with node:crypto alone (no openssl): an EC P-256 key
// and a minimal X.509 v3 certificate for CN=localhost, DER-encoded by hand, as PEM.
import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';

const len = (n) => (n < 128 ? Buffer.from([n]) : n < 256 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 255]));
const tlv = (tag, body) => Buffer.concat([Buffer.from([tag]), len(body.length), body]);
const seq = (...parts) => tlv(0x30, Buffer.concat(parts));
const oid = (s) => {
  const [a, b, ...rest] = s.split('.').map(Number);
  const out = [40 * a + b];
  for (const n of rest) {
    const bytes = [n & 127];
    for (let v = n >> 7; v; v >>= 7) bytes.unshift((v & 127) | 128);
    out.push(...bytes);
  }
  return tlv(0x06, Buffer.from(out));
};
const utc = (d) => tlv(0x17, Buffer.from(`${d.toISOString().slice(2, 19).replace(/[-T:]/g, '')}Z`));
const name = (cn) => seq(tlv(0x31, seq(oid('2.5.4.3'), tlv(0x0c, Buffer.from(cn)))));
const pem = (label, der) => `-----BEGIN ${label}-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;

export function selfSigned(cn = 'localhost') {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const alg = seq(oid('1.2.840.10045.4.3.2')); // ecdsa-with-SHA256
  const now = Date.now();
  const tbs = seq(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))), // v3
    tlv(0x02, Buffer.from([1, 2, 3, 4])),
    alg,
    name(cn),
    seq(utc(new Date(now - 86400000)), utc(new Date(now + 30 * 86400000))),
    name(cn),
    publicKey.export({ type: 'spki', format: 'der' }),
  );
  const signature = sign('sha256', tbs, privateKey);
  const cert = seq(tbs, alg, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
  return { cert: pem('CERTIFICATE', cert), key: createPrivateKey(privateKey.export({ type: 'pkcs8', format: 'pem' })).export({ type: 'pkcs8', format: 'pem' }) };
}
