// The audit log (07 §7.12): an append-only record of who did what, kept 90 days by default. Logins
// (both ways), session revocations, user and role changes, tokens, templates, overlay upgrades,
// cue overrides and the platform's own updates. Each entry: time, actor, IP, action, target and a
// few details, never a secret (they pass the logger's redaction too).
//
//   store collection "audit"  id aud_<inverted time><inverted sequence><random>, so a plain scan
//                             reads newest first, within one millisecond too
import { randomBytes } from 'node:crypto';
import { userInfo } from 'node:os';
import { redact } from '../log.js';

export const AUDIT_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
const FAR = 10 ** 13; // epoch ms stay below this until the year 2286
const keyAt = (ms) => `aud_${String(FAR - ms).padStart(13, '0')}`;

export function createAudit({ store, now = Date.now, retentionDays = AUDIT_DAYS }) {
  let lastPrune = 0;
  let lastAt = -1;
  let seq = 0;
  const idAt = (t) => {
    seq = t === lastAt ? seq + 1 : 0;
    lastAt = t;
    return `${keyAt(t)}${String(999999 - Math.min(seq, 999999)).padStart(6, '0')}${randomBytes(3).toString('hex')}`;
  };

  function prune() {
    lastPrune = now();
    const cutoff = keyAt(now() - retentionDays * DAY_MS);
    for (;;) {
      const old = store.list('audit', { after: cutoff, limit: 1000 });
      for (const doc of old) store.delete('audit', doc.id);
      if (old.length < 1000) break;
    }
  }

  return {
    // entry: { action, actor, ip?, target?, ...details }. Never throws: what it records is done.
    record(entry) {
      try {
        const t = now();
        const { action, actor, ip, target, ...details } = entry;
        const data = { at: new Date(t).toISOString(), action: String(action), actor: String(actor ?? 'unknown') };
        if (ip) data.ip = String(ip);
        if (target !== undefined) data.target = String(target);
        const extra = redact(details);
        if (extra && Object.keys(extra).length) data.details = extra;
        store.put('audit', idAt(t), data, { ifRev: 0 });
        if (t - lastPrune > DAY_MS) prune();
      } catch {
        // An audit entry that can't be written must not undo or hide the change it describes.
      }
    },
    // Newest first: { items, next }; `cursor` is the last id of the previous page.
    list({ limit = 50, cursor = '', action } = {}) {
      const items = [];
      let after = typeof cursor === 'string' && cursor.startsWith('aud_') ? cursor : '';
      while (items.length < limit) {
        const page = store.list('audit', { after, limit: 200 });
        for (const doc of page) {
          after = doc.id;
          if (action && doc.data.action !== action && !doc.data.action.startsWith(`${action}.`)) continue;
          items.push({ id: doc.id, ...doc.data });
          if (items.length >= limit) break;
        }
        if (page.length < 200) {
          if (items.length < limit) after = '';
          break;
        }
      }
      return { items, next: items.length >= limit && after ? after : undefined };
    },
    prune,
  };
}

// Who is at this terminal, for changes made from the command line.
export function cliActor() {
  try { return `cli:${userInfo().username}`; } catch { return 'cli'; }
}
