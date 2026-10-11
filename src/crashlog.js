// crash.log in the data directory (10 §10.8): every unexpected error, with its stack trace, one
// JSON object per line, kept for 30 days. It is what you read after a show to find out what went
// wrong, so writing to it must never throw.
import { appendFileSync, readFileSync } from 'node:fs';
import { atomicWriteFileSync } from './fsutil.js';
import { redact } from './log.js';

export function createCrashLog(file, { now = () => new Date() } = {}) {
  return {
    file,
    record(kind, err, context) {
      const entry = { ts: now().toISOString(), kind, error: redact(err) };
      if (context !== undefined) entry.context = redact(context);
      try { appendFileSync(file, JSON.stringify(entry) + '\n'); } catch {}
    },
    // Drops entries older than `days`. Lines that can't be parsed are dropped too.
    prune(days = 30) {
      let text;
      try { text = readFileSync(file, 'utf8'); } catch { return 0; }
      const cutoff = now().getTime() - days * 86400000;
      const lines = text.split('\n').filter(Boolean);
      const kept = lines.filter((line) => {
        try { return Date.parse(JSON.parse(line).ts) >= cutoff; } catch { return false; }
      });
      if (kept.length !== lines.length) {
        try { atomicWriteFileSync(file, kept.map((l) => l + '\n').join('')); } catch {}
      }
      return lines.length - kept.length;
    },
  };
}
