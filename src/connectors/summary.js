// The overlay summary (CTD Relay's docs/API.md §9.5, ctd-overlay-summary/1): what the CTD OBS
// plugin's "CTD Overlays" dock shows about this platform, beside the overlays a CTD Relay
// connection registers: this platform's version, each template's installed version against the
// newest release of the source it follows (04 §4.13), whether an update moves overlays by itself
// (patch and minor, with autoUpgrade "safe") or waits for the operator (major), the overlays that
// wait, and the newest release's notes, trimmed.
//
// Pure: it reads lists and returns plain JSON. Only the fields below are ever put in it: never an
// overlay's key or URL, a GitHub token, a file path or an error's message (a code only).
import { compareVersions } from '../templates/registry.js';
import { isMajor } from '../overlays/registry.js';
import { NOTE_LINE_CHARS, NOTE_LINES } from '../templates/notes.js';

export { trimNotes } from '../templates/notes.js';

export const SUMMARY_SCHEMA = 'ctd-overlay-summary/1';
const MAX_TEMPLATES = 200;
const MAX_OVERLAYS = 500;
const VERSION = /^v?\d+(\.\d+){0,2}([-+][0-9A-Za-z.-]+)?$/;
const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const CODE = /^[a-z0-9-]{1,40}$/;
const TAG_PREFIX = /^[A-Za-z0-9._/-]{1,64}$/;

const str = (v) => typeof v === 'string' && v.length > 0;
const clip = (s, n) => {
  const t = String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim(); // eslint-disable-line no-control-regex
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};
const version = (v) => (str(v) && v.length <= 40 && VERSION.test(v) ? v : undefined);

// The version a release tag names ("v1.3.0", "overlay-v1.3.0" → "1.3.0"), or undefined.
export function versionOfTag(tag) {
  const m = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(String(tag ?? ''));
  return m ? m[1] : undefined;
}

// What moving from version `from` to `to` is: 'none' (not newer), 'major' (the major version
// changes, or the minor one before 1.0.0, or either is a pre-release: the same rule as an
// overlay's upgrade, 04 §4.10), 'minor' or 'patch'.
export function updateKind(from, to) {
  if (!version(from) || !version(to) || compareVersions(to, from) <= 0) return 'none';
  if (isMajor(from, to)) return 'major';
  const [, a = 0] = String(from).split(/[-+]/)[0].split('.').map(Number);
  const [, b = 0] = String(to).split(/[-+]/)[0].split('.').map(Number);
  return a !== b ? 'minor' : 'patch';
}

// templates: the template registry (list(), versions(id)); sources: the followed sources
// (records { id, data }); overlays: the overlays this summary is about (records { id, data });
// allOverlays: every overlay, for the versions in use (defaults to overlays); shows: the shows
// ({ name, overlays: [ids] }); ui: the admin UI address; serverVersion: this platform's.
export function buildSummary({ templates, sources = [], overlays = [], allOverlays = overlays, shows = [], ui, serverVersion }) {
  const newestOf = new Map();
  for (const t of templates.list()) {
    const cur = newestOf.get(t.id);
    if (!cur || compareVersions(t.version, cur.version) > 0) newestOf.set(t.id, t);
  }
  const sourceOf = new Map();
  // One template has one source, but a source pinned to one release (owner/name@v1.2.0) may share
  // it with the one that follows the repository's new releases: that one says what comes next.
  for (const s of sources) {
    const id = s.data?.templateId;
    if (!str(id)) continue;
    const cur = sourceOf.get(id);
    if (!cur || (cur.tag !== undefined && s.data.tag === undefined)) sourceOf.set(id, s.data);
  }
  const inUse = new Map();
  for (const o of allOverlays) {
    const pin = o.data?.template;
    if (!str(pin?.id) || !version(pin.version)) continue;
    if (!inUse.has(pin.id)) inUse.set(pin.id, new Set());
    inUse.get(pin.id).add(pin.version);
  }

  const templateList = [...newestOf.values()].sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, MAX_TEMPLATES).map((t) => {
    const d = sourceOf.get(t.id);
    const used = [...(inUse.get(t.id) || [])].sort((a, b) => compareVersions(b, a));
    const installed = version(t.version) || '0.0.0';
    const fromSource = version(d?.version);
    const failedAt = d?.failed?.release ? versionOfTag(d.failed.release) : undefined;
    const latest = [fromSource, failedAt, versionOfTag(d?.release)].filter(Boolean).sort((a, b) => compareVersions(b, a))[0];
    const target = latest && compareVersions(latest, installed) > 0 ? latest : installed;
    const oldest = used.length ? used[used.length - 1] : installed;
    const out = { id: t.id, name: clip(t.manifest?.name || t.id, 120) || t.id, installed };
    if (used.length) out.oldestInUse = used[used.length - 1];
    if (d) {
      // A repository can hold several templates, one per release tag prefix ("show-v", "tn-v"): the
      // source is the repository and its prefix together.
      const prefix = typeof d.tagPrefix === 'string' && TAG_PREFIX.test(d.tagPrefix) ? d.tagPrefix : undefined;
      out.source = { kind: d.kind === 'url' ? 'url' : 'github', ...(d.kind === 'github' && REPO.test(d.repo || '') ? { repo: d.repo } : {}), ...(d.kind === 'github' && prefix ? { tagPrefix: prefix } : {}), ...(d.tag !== undefined ? { pinned: true } : {}) };
      out.latest = latest ?? null;
      out.auto = d.autoUpgrade !== 'off';
      out.checkedAt = str(d.checkedAt) ? d.checkedAt : null;
      if (d.error && CODE.test(String(d.error.code || ''))) out.problem = d.error.code;
      const notes = Array.isArray(d.notes) ? d.notes.map((l) => clip(l, NOTE_LINE_CHARS)).filter(Boolean).slice(0, NOTE_LINES) : [];
      const notesFor = version(d.notesVersion) || fromSource;
      // One string, lines joined with "\n": the OBS plugin's JSON reader (libobs obs_data) drops arrays of strings.
      if (notes.length && notesFor) out.notes = [{ version: notesFor, text: notes.join('\n') }];
    } else {
      out.source = { kind: 'none' };
    }
    out.update = updateKind(oldest, target);
    return out;
  });

  const showOf = (id) => shows.find((s) => Array.isArray(s.overlays) && s.overlays.includes(id))?.name;
  const overlayList = [...overlays].sort((a, b) => (a.data.slug < b.data.slug ? -1 : 1)).slice(0, MAX_OVERLAYS).flatMap((o) => {
    const pin = o.data?.template;
    if (!str(pin?.id) || !version(pin.version) || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(o.data.slug || '')) return [];
    const t = newestOf.get(pin.id);
    const d = sourceOf.get(pin.id);
    const item = { id: o.id, slug: o.data.slug, template: { id: pin.id, ...(t?.manifest?.name ? { name: clip(t.manifest.name, 120) } : {}), version: pin.version } };
    const show = showOf(o.id);
    item.show = show ? clip(show, 120) : null;
    const newest = version(t?.version);
    if (newest && compareVersions(newest, pin.version) > 0) {
      const major = isMajor(pin.version, newest);
      // What waits for the operator: a major version always; with no source (installed by
      // hand) or automatic upgrades off, any version; a live show's, until it ends.
      const why = major ? 'a major version'
        : !d ? 'installed by hand: upgrade it in CTD Overlay'
          : d.autoUpgrade === 'off' ? 'automatic upgrades are off'
            : Array.isArray(d.pending) && d.pending.includes(o.id) ? 'its show is live; it moves after' : undefined;
      if (why) item.waiting = { to: newest, major, why };
    }
    return [item];
  });

  return {
    schema: SUMMARY_SCHEMA,
    server: { name: 'CTD Overlay', version: version(serverVersion) ?? null },
    ui: cleanUi(ui),
    templates: templateList,
    overlays: overlayList,
  };
}

// The admin UI's address without credentials, path, query or fragment; null when unknown.
export function cleanUi(ui) {
  if (!str(ui)) return null;
  try {
    const u = new URL(ui);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}
