// Template sources (04 §4.13): where new versions of a template come from, so a template can be
// updated remotely and the platform picks the update up by itself. A source is a GitHub
// repository's releases, or an https URL that always serves the current package.
//
//   store collection "template_sources"   one record per source (id src_…)
//
// The running platform checks every source every templateCheckMinutes (60 by default), and
// `skp template update` checks now. A new release is downloaded (https only, at most 100 MiB, in
// 2 minutes), validated and installed beside the versions already there: installing changes no
// running overlay (04 §4.10). Then, with autoUpgrade "safe" (the default), each overlay on an
// older version of that template moves to the new one when the upgrade needs no confirmation:
// the same major version, nothing the operator set or a show may name dropped, no migrate.js to
// run (04 §4.10). The rest wait for the operator (`skp overlay upgrade`), and the log says so.
// "off" only installs. Every install and upgrade it makes is in the audit log.
//
// From a GitHub release it takes the attached .skp (else a .zip), or failing both the release's
// source zip, which works for a repository with template.json at its root.
//
// Trust: what a source installs is code from whoever controls it (04 §4.1). The first release
// fixes the template id a source may install; a later one with another id is refused, so a
// repository can't take over another template's overlays. A token (SKP_GITHUB_TOKEN, for private
// repositories) is sent to api.github.com only, never to a host a download is redirected to.
import { randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { createWriteStream, rmSync } from 'node:fs';
import { isIP } from 'node:net';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { newId } from '../ids.js';
import { isPrivateAddress, pinnedFetch } from '../net.js';
import { compareVersions, TemplateError, validateTemplate } from './registry.js';
import { ZipError } from './zip.js';

export const SOURCE_LIMITS = Object.freeze({
  bytes: 100 * 1024 * 1024, // a package's own limit (04 §4.1)
  downloadMs: 120000,
  apiMs: 30000,
  apiBytes: 1024 * 1024, // a release's JSON
  redirects: 5,
  firstCheckMs: 30000, // after the platform starts, so a check never competes with startup
});
export const AUTO_UPGRADE = ['safe', 'off'];
const COLLECTION = 'template_sources';
const API = 'https://api.github.com';
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;
const TAG = /^[^\s~^:?*[\\\u0000-\u001f\u007f]{1,128}$/; // eslint-disable-line no-control-regex

export class SourceError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'SourceError';
    this.code = code;
  }
}

// "owner/repo", "owner/repo@tag", "github:owner/repo[@tag]" or a github.com repository or release
// URL → { kind: 'github', repo, tag? }; any other https URL → { kind: 'url', url }.
export function parseSource(input) {
  const s = String(input ?? '').trim();
  if (!s.includes('://')) {
    const m = /^(?:github:)?([^/@\s]+)\/([^/@\s]+?)(?:\.git)?(?:@(.+))?$/.exec(s);
    if (!m || !OWNER.test(m[1]) || !NAME.test(m[2]) || m[2] === '.' || m[2] === '..') {
      throw new SourceError(`"${s}" is not a GitHub repository (owner/name, or owner/name@tag) or an https URL.`, 'bad-source');
    }
    if (m[3] !== undefined && !TAG.test(m[3])) throw new SourceError(`"${m[3]}" is not a release tag.`, 'bad-source');
    return { kind: 'github', repo: `${m[1]}/${m[2]}`, ...(m[3] !== undefined ? { tag: m[3] } : {}) };
  }
  let url;
  try { url = new URL(s); } catch { throw new SourceError(`"${s}" is not a GitHub repository (owner/name) or an https URL.`, 'bad-source'); }
  if (url.protocol !== 'https:') throw new SourceError('Only https URLs are accepted: a package is code, and must not be changed on the way.', 'not-https');
  if (url.username || url.password) throw new SourceError('Put no credentials in the URL; for a private GitHub repository set SKP_GITHUB_TOKEN.', 'bad-source');
  if (url.hostname === 'github.com' && !url.search && !url.hash) {
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length === 2) return parseSource(`${parts[0]}/${parts[1]}`);
    if (parts.length >= 5 && parts[2] === 'releases' && parts[3] === 'tag') return parseSource(`${parts[0]}/${parts[1]}@${decodeURIComponent(parts.slice(4).join('/'))}`);
  }
  return { kind: 'url', url: url.href };
}

// How a source is shown and matched: github:owner/repo[@tag], or the URL.
export function describeSource(source) {
  return source.kind === 'github' ? `github:${source.repo}${source.tag !== undefined ? `@${source.tag}` : ''}` : source.url;
}

// Addresses a download must never reach unless the owner allows it (07 §7.11): this machine,
// the local network, link-local (cloud metadata) and other non-public ranges (net.js).
export { isPrivateAddress };

// A host a download may go to: its addresses, looked up, are all public, unless the owner allowed
// private ones (SKP_ALLOW_PRIVATE_DOWNLOADS). This refuses early, with a clear message. The default
// fetch (net.js pinnedFetch) checks again in the lookup it connects with, so a DNS-rebinding host
// can't answer this check with a public address and the connection with a private one; a fetch
// passed in (a test hook) has only this check.
async function checkHost(hostname, net) {
  if (!net || net.allowPrivate) return;
  const host = hostname.replace(/^\[|\]$/g, '');
  let addresses;
  if (isIP(host)) addresses = [host];
  else {
    try {
      addresses = (await net.lookup(host)).map((a) => a.address);
    } catch (err) {
      throw new SourceError(`${host} could not be found (${err.code || err.message}).`, 'unreachable');
    }
  }
  const inside = addresses.find(isPrivateAddress);
  if (inside) {
    throw new SourceError(`${host} is a private or local address (${inside}); downloads go to the public internet only, unless the owner sets SKP_ALLOW_PRIVATE_DOWNLOADS=true.`, 'private-address');
  }
}
export const defaultLookup = (host) => lookup(host, { all: true });

// One request, following redirects by hand: every hop must be https and public (checkHost), and
// a token goes to api.github.com only (a release download redirects to a storage host with its
// own signature).
async function request(fetchFn, url, { headers = {}, token, signal, max = SOURCE_LIMITS, net }) {
  let current = url;
  for (let hop = 0; hop <= max.redirects; hop++) {
    let target;
    try { target = new URL(current); } catch { throw new SourceError('The server sent a link that is not a URL.', 'bad-response'); }
    if (target.protocol !== 'https:') throw new SourceError(`The download was sent to ${target.protocol}//${target.host}; only https is followed.`, 'not-https');
    await checkHost(target.hostname, net);
    const h = { 'user-agent': 'skp-platform', ...headers };
    if (token && target.hostname === 'api.github.com') h.authorization = `Bearer ${token}`;
    let res;
    try {
      res = await fetchFn(target.href, { headers: h, redirect: 'manual', signal });
    } catch (err) {
      if (err?.code === 'EPRIVATE') throw new SourceError(`${err.message}; downloads go to the public internet only, unless the owner sets SKP_ALLOW_PRIVATE_DOWNLOADS=true.`, 'private-address');
      throw failure(err, signal, `${target.host} could not be reached`, 'unreachable');
    }
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get('location');
      await res.body?.cancel().catch(() => {});
      if (!location) throw new SourceError(`${target.host} redirected without saying where.`, 'bad-response');
      current = new URL(location, target).href;
      continue;
    }
    return res;
  }
  throw new SourceError(`More than ${max.redirects} redirects.`, 'bad-response');
}

async function readJson(res, signal, max) {
  let text;
  try {
    text = await readLimited(res, max.apiBytes);
  } catch (err) {
    throw failure(err, signal, 'GitHub\'s answer was cut off', 'unreachable');
  }
  try { return JSON.parse(text); } catch { throw new SourceError('GitHub answered with something that is not JSON.', 'bad-response'); }
}

// What a failed request becomes: a SourceError as it is; an abort, "timeout" or "stopped" (the
// platform shutting down), by the signal's reason; anything else `code`, with what went wrong.
function failure(err, signal, what, code) {
  if (err instanceof SourceError) return err;
  if (signal?.aborted) {
    return signal.reason?.name === 'TimeoutError'
      ? new SourceError(`${what}: it took too long.`, 'timeout')
      : new SourceError('Stopped (the platform is shutting down).', 'stopped');
  }
  return new SourceError(`${what} (${err.cause?.code || err.code || err.message}).`, code);
}

async function readLimited(res, max) {
  const chunks = [];
  let size = 0;
  for await (const chunk of Readable.fromWeb(res.body)) {
    size += chunk.length;
    if (size > max) throw new SourceError('The answer is larger than expected.', 'bad-response');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// The release a GitHub source points at (its tag, or the latest published one): { unchanged }
// when the ETag says nothing changed, else { tag, etag, download: { name, url, size, accept } }.
async function githubRelease(fetchFn, source, { token, etag, signal, max = SOURCE_LIMITS, net }) {
  const url = source.tag !== undefined
    ? `${API}/repos/${source.repo}/releases/tags/${encodeURIComponent(source.tag)}`
    : `${API}/repos/${source.repo}/releases/latest`;
  const headers = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };
  if (etag) headers['if-none-match'] = etag;
  const deadline = anySignal(signal, max.apiMs);
  const res = await request(fetchFn, url, { headers, token, signal: deadline, max, net });
  if (res.status === 304) {
    await res.body?.cancel().catch(() => {});
    return { unchanged: true, etag };
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    if (res.status === 404) {
      throw new SourceError(`${source.repo} has no ${source.tag !== undefined ? `release "${source.tag}"` : 'published release'}${token ? '' : ', or it is private (set SKP_GITHUB_TOKEN to a token that can read it)'}.`, 'no-release');
    }
    if (res.status === 401) throw new SourceError('GitHub refused SKP_GITHUB_TOKEN (expired, or not allowed to read this repository).', 'unauthorized');
    if ((res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0') {
      const reset = Number(res.headers.get('x-ratelimit-reset'));
      const until = reset ? ` until ${new Date(reset * 1000).toISOString()}` : '';
      throw new SourceError(`GitHub's limit on requests from this address is used up${until}${token ? '' : '; SKP_GITHUB_TOKEN raises it'}.`, 'rate-limited');
    }
    throw new SourceError(`GitHub answered ${res.status}.`, 'bad-response');
  }
  const body = await readJson(res, deadline, max);
  if (!body || typeof body !== 'object' || typeof body.tag_name !== 'string') throw new SourceError('GitHub\'s answer has no release in it.', 'bad-response');
  const assets = (Array.isArray(body.assets) ? body.assets : []).filter((a) => a && typeof a.name === 'string');
  const ending = (ext) => assets.filter((a) => a.name.toLowerCase().endsWith(ext)).sort((a, b) => (a.name < b.name ? -1 : 1))[0];
  const asset = ending('.skp') || ending('.zip');
  let download;
  if (asset) {
    // With a token, the asset's API URL (which works for private repositories too); without one,
    // its public download link.
    const assetUrl = token ? asset.url : asset.browser_download_url;
    if (typeof assetUrl !== 'string') throw new SourceError('GitHub\'s answer has no link for the release\'s package.', 'bad-response');
    download = { name: asset.name, url: assetUrl, size: Number(asset.size) || undefined, accept: token ? 'application/octet-stream' : undefined };
  } else {
    if (typeof body.zipball_url !== 'string') throw new SourceError('The release has no .skp or .zip attached and no source zip.', 'bad-response');
    download = { name: 'source zip', url: body.zipball_url };
  }
  return { tag: body.tag_name, etag: res.headers.get('etag') || undefined, download };
}

// Downloads to a file in dir, refusing more than the limit: { file, size, etag, lastModified },
// or { unchanged } when a conditional request says the file is the one already seen.
async function download(fetchFn, url, dir, { token, accept, etag, lastModified, signal, max = SOURCE_LIMITS, net }) {
  const headers = {};
  if (accept) headers.accept = accept;
  if (etag) headers['if-none-match'] = etag;
  else if (lastModified) headers['if-modified-since'] = lastModified;
  const file = path.join(dir, `.download-${randomBytes(6).toString('hex')}`);
  const deadline = anySignal(signal, max.downloadMs);
  try {
    const res = await request(fetchFn, url, { headers, token, signal: deadline, max, net });
    if (res.status === 304 && (etag || lastModified)) {
      await res.body?.cancel().catch(() => {});
      return { unchanged: true };
    }
    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => {});
      throw new SourceError(`The download answered ${res.status}.`, 'download-failed');
    }
    const declared = Number(res.headers.get('content-length'));
    if (declared > max.bytes) {
      await res.body.cancel().catch(() => {});
      throw new SourceError(`The package is larger than ${mib(max.bytes)}.`, 'too-large');
    }
    let size = 0;
    const cap = new Transform({
      transform(chunk, _enc, done) {
        size += chunk.length;
        if (size > max.bytes) done(new SourceError(`The package is larger than ${mib(max.bytes)}.`, 'too-large'));
        else done(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body), cap, createWriteStream(file, { flags: 'wx', mode: 0o644 }));
    if (!size) throw new SourceError('The download was empty.', 'download-failed');
    return { file, size, etag: res.headers.get('etag') || undefined, lastModified: res.headers.get('last-modified') || undefined };
  } catch (err) {
    rmSync(file, { force: true });
    throw failure(err, deadline, 'The download failed', 'download-failed');
  }
}

// A signal that aborts with `signal` or after ms.
function anySignal(signal, ms) {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

const mib = (bytes) => (bytes >= 1024 * 1024 ? `${Math.round(bytes / 1024 / 1024)} MiB` : `${bytes} bytes`);

function tooLarge(rel, max) {
  if (rel.download.size > max.bytes) throw new SourceError(`The release's package is larger than ${mib(max.bytes)}.`, 'too-large');
}

// Fetches one package from a source, once, for `skp template install <source>`: { file, origin,
// label } (the caller installs it, then removes the file). allowPrivate: the owner's
// SKP_ALLOW_PRIVATE_DOWNLOADS. lookup and limits: test hooks.
export async function fetchPackage(input, { dir, token, fetch, signal, limits, lookup: lookupFn = defaultLookup, allowPrivate = false } = {}) {
  // The default connects only to the address it checked (net.js pinnedFetch).
  const fetchFn = fetch || pinnedFetch({ lookup: lookupFn, allowPrivate });
  const max = { ...SOURCE_LIMITS, ...limits };
  const net = { lookup: lookupFn, allowPrivate };
  const source = typeof input === 'string' ? parseSource(input) : input;
  if (source.kind === 'github') {
    const rel = await githubRelease(fetchFn, source, { token, signal, max, net });
    tooLarge(rel, max);
    const got = await download(fetchFn, rel.download.url, dir, { token, accept: rel.download.accept, signal, max, net });
    return { file: got.file, origin: { kind: 'github', repo: source.repo, tag: rel.tag, asset: rel.download.name }, label: `${source.repo}@${rel.tag}`, tag: rel.tag, etag: rel.etag };
  }
  const got = await download(fetchFn, source.url, dir, { signal, max, net });
  return { file: got.file, origin: { kind: 'url', url: source.url }, label: source.url, etag: got.etag, lastModified: got.lastModified };
}

// Errors a release won't grow out of by itself: until the source publishes something else, it
// isn't downloaded again (an unchanged release costs one small request, 04 §4.13).
const LASTING = new Set(['invalid', 'wrong-template', 'id-taken', 'reserved-id', 'version-exists', 'too-large']);

// The sources the platform follows. record(action, details) writes the audit log. onAir(overlayId):
// whether the overlay's show is live (an upgrade reloads its pages, so it waits). allowPrivate:
// the owner's SKP_ALLOW_PRIVATE_DOWNLOADS. limits and lookup: test hooks.
export function createTemplateSources({ store, templates, overlays, log, token, fetch, record = () => {}, limits, onAir = () => false, lookup: lookupFn = defaultLookup, allowPrivate = false }) {
  const fetchFn = fetch || pinnedFetch({ lookup: lookupFn, allowPrivate });
  const max = { minuteMs: 60000, ...SOURCE_LIMITS, ...limits };
  const net = { lookup: lookupFn, allowPrivate };
  let chain = Promise.resolve();
  let timer = null;
  let stopped = false;
  const stopping = new AbortController();

  function* all() {
    for (let after = ''; ;) {
      const page = store.list(COLLECTION, { after, limit: 1000 });
      yield* page;
      if (page.length < 1000) break;
      after = page[page.length - 1].id;
    }
  }

  // By id, or by what was followed (owner/repo, github:owner/repo, the URL).
  function find(ref) {
    const byId = typeof ref === 'string' && ref.startsWith('src_') ? store.get(COLLECTION, ref) : undefined;
    if (byId) return byId;
    let label;
    try { label = describeSource(parseSource(ref)); } catch { return undefined; }
    return [...all()].find((d) => d.data.label === label);
  }

  // claim: a template id this source may take over although it is installed from elsewhere (the
  // operator's own choice: `follow … --template <id>`).
  function add(input, { autoUpgrade = 'safe', actor = 'cli', claim } = {}) {
    if (!AUTO_UPGRADE.includes(autoUpgrade)) throw new SourceError(`autoUpgrade must be one of ${AUTO_UPGRADE.join(', ')}.`, 'bad-option');
    if (claim !== undefined && (typeof claim !== 'string' || !/^[a-z0-9]+(\.[a-z0-9-]+){2,}$/.test(claim))) throw new SourceError(`"${claim}" is not a template id.`, 'bad-option');
    const source = parseSource(input);
    const label = describeSource(source);
    if (find(label)) throw new SourceError(`${label} is already followed.`, 'exists');
    return store.put(COLLECTION, newId('src'), { label, ...source, autoUpgrade, ...(claim ? { claim } : {}), addedAt: new Date().toISOString(), actor });
  }

  function remove(ref) {
    const doc = find(ref);
    if (!doc) throw new SourceError(`${ref} is not followed.`, 'not-found');
    store.delete(COLLECTION, doc.id);
    return doc;
  }

  function update(doc, changes) {
    const current = store.get(COLLECTION, doc.id);
    if (!current) return doc; // removed meanwhile
    const data = { ...current.data, ...changes };
    for (const k of Object.keys(data)) if (data[k] === undefined) delete data[k];
    return store.put(COLLECTION, doc.id, data);
  }

  // Where an installed version came from, and whether that is this source (the same repository
  // or URL, whatever tag it pins).
  const sameOrigin = (from, d) => !!from && ((from.kind === 'github' && d.kind === 'github' && from.repo === d.repo) || (from.kind === 'url' && d.kind === 'url' && from.url === d.url));
  const sameSource = (a, b) => (a.kind === 'github' && b.kind === 'github' && a.repo === b.repo) || (a.kind === 'url' && b.kind === 'url' && a.url === b.url);
  const originOf = (t) => {
    const s = t.receipt?.source;
    if (!s || templates.fromPlatform(t)) return 'the platform';
    if (s.kind === 'github') return `github:${s.repo}`;
    if (s.kind === 'url') return s.url;
    return `a package (${s.name || 'a file'})`;
  };

  // Whether this source may install template `id` (its first release decides what it installs):
  // never one that ships with the platform, never one another source installs, and not one
  // installed from elsewhere unless the operator said so (04 §4.13: a repository can't take over
  // another template's overlays).
  function claimProblem(doc, id) {
    const d = doc.data;
    const versions = templates.versions(id);
    if (versions.some((t) => templates.fromPlatform(t))) return `${id} ships with the platform; a source can't publish versions of it.`;
    const other = [...all()].find((o) => o.id !== doc.id && o.data.templateId === id && !sameSource(o.data, d));
    if (other) return `${id} already comes from ${other.data.label}; one template has one source.`;
    if (d.claim === id) return undefined;
    const foreign = versions.find((t) => !sameOrigin(t.receipt?.source, d));
    if (foreign) return `${id} is already installed from ${originOf(foreign)}. To have this source update it, follow it with --template ${id}.`;
    return undefined;
  }

  // Checks one source (ref) or all of them, one at a time. Resolves with one result per source:
  // { source, id, tag?, unchanged?, installed?: { id, version, build, noop, warnings },
  //   upgraded: [], waiting: [], error?: { code, message } }. Never rejects for a source's own
  // failure; with nothing followed, resolves with [].
  function check(ref, { force = false } = {}) {
    const run = chain.then(async () => {
      if (stopped) throw new SourceError('The platform is shutting down.', 'stopped');
      const docs = ref === undefined ? [...all()] : [find(ref)];
      if (ref !== undefined && docs[0] === undefined) throw new SourceError(`${ref} is not followed.`, 'not-found');
      const results = [];
      for (const doc of docs) {
        if (stopped) break;
        results.push(await checkOne(doc, force));
      }
      return results;
    });
    chain = run.catch(() => {});
    return run;
  }

  async function checkOne(doc, force) {
    const d = doc.data;
    const result = { source: d.label, id: doc.id, upgraded: [], waiting: [] };
    const checkedAt = new Date().toISOString();
    // A release that failed for good (it isn't a template, it claims another one, …) is what the
    // conditional request compares against, so it isn't fetched again until something changes.
    const known = force ? {} : d.failed || { etag: d.etag, lastModified: d.lastModified, release: d.release };
    let seen = {};
    let file;
    const unchanged = async () => {
      update(doc, { checkedAt, ...(d.failed ? {} : { error: undefined }) });
      if (d.failed) return { ...result, tag: d.failed.release, unchanged: true, error: d.error };
      return { ...result, tag: d.release, unchanged: true, ...(await upgradeOverlays(doc, { pendingOnly: true })) };
    };
    try {
      const dir = templates.downloadDir;
      if (!dir) throw new SourceError('Templates can\'t be installed here: another process holds the data directory.', 'read-only');
      let origin;
      let label;
      if (d.kind === 'github') {
        const rel = await githubRelease(fetchFn, d, { token, etag: known.etag, signal: stopping.signal, max, net });
        if (rel.unchanged || (!force && rel.tag === known.release && (d.version || d.failed))) {
          if (rel.etag && !d.failed) update(doc, { etag: rel.etag });
          return await unchanged();
        }
        seen = { release: rel.tag, etag: rel.etag }; // `tag` is the one a source may pin
        result.tag = rel.tag;
        tooLarge(rel, max);
        ({ file } = await download(fetchFn, rel.download.url, dir, { token, accept: rel.download.accept, signal: stopping.signal, max, net }));
        origin = { kind: 'github', repo: d.repo, tag: rel.tag, asset: rel.download.name };
        label = `${d.repo}@${rel.tag}`;
      } else {
        const got = await download(fetchFn, d.url, dir, { etag: known.etag, lastModified: known.lastModified, signal: stopping.signal, max, net });
        if (got.unchanged) return await unchanged();
        file = got.file;
        seen = { etag: got.etag, lastModified: got.lastModified };
        origin = { kind: 'url', url: d.url };
        label = d.url;
      }
      let checked;
      try {
        checked = validateTemplate(file);
      } catch (err) {
        if (!(err instanceof ZipError)) throw err;
        throw new SourceError(`The release's file isn't a template package: ${err.message}`, 'invalid');
      }
      if (checked.errors.length) {
        throw new SourceError(`The package has ${checked.errors.length} problem${checked.errors.length === 1 ? '' : 's'}: ${checked.errors.slice(0, 3).map((e) => e.message).join(' ')}`, 'invalid');
      }
      const { id, version } = checked.manifest;
      if (d.templateId && id !== d.templateId) {
        throw new SourceError(`This source installs ${d.templateId}, but this release is ${id}; a source can't switch templates (follow the new one on its own).`, 'wrong-template');
      }
      if (!d.templateId) {
        const problem = claimProblem(doc, id);
        if (problem) throw new SourceError(problem, 'id-taken');
      }
      const { template, noop, warnings } = templates.install(file, { actor: 'updater', name: label, origin });
      result.installed = { id, version, build: template.build, noop, warnings };
      if (!noop) {
        log.info('template installed from its source', { source: d.label, template: `${id}@${version}`, build: template.build });
        record('template.update', { source: d.label, release: seen.release, template: `${id}@${version}`, build: template.build });
      }
      // What 04 §4.11 has to show: the warnings, for releases nobody watched install.
      for (const w of warnings) log.warn('a template release has a warning', { source: d.label, template: `${id}@${version}`, code: w.code, path: w.path, message: w.message });
      // Only a version that is new to this source moves overlays; the same one again (a URL with
      // no validators, a new tag on the same package) never undoes an operator's revert.
      const fresh = version !== d.version;
      const saved = update(doc, { templateId: id, version, checkedAt, error: undefined, failed: undefined, ...seen });
      Object.assign(result, await upgradeOverlays(saved, { pendingOnly: !fresh, announce: fresh }));
    } catch (err) {
      if (!(err instanceof SourceError || err instanceof TemplateError)) log.error('checking a template source failed', { source: d.label, err });
      const error = { code: err.code || 'failed', message: err.message };
      result.error = error;
      if (error.code !== 'stopped') {
        log.warn('a template source could not be checked', { source: d.label, code: error.code, err: error.message });
        const failed = LASTING.has(error.code) && (seen.etag || seen.lastModified || seen.release) ? { ...seen } : undefined;
        update(doc, { checkedAt, error: { ...error, at: checkedAt }, ...(failed ? { failed } : {}) });
      }
    } finally {
      if (file) rmSync(file, { force: true });
    }
    return result;
  }

  // Moves this source's overlays to the version it last installed, when that is the newest
  // installed version (a release older than what is installed never moves an overlay back), the
  // version they are on came from this source (or the operator let it claim the template), and
  // the upgrade needs no confirmation and runs no migrate.js (04 §4.10). An overlay whose show is
  // live waits, and is kept as pending: it moves at the first check after. pendingOnly: only those
  // (nothing new arrived: anything else stays where the operator left it, a revert included).
  // announce: log why the others wait (once, when the version arrives).
  async function upgradeOverlays(doc, { pendingOnly = false, announce = false } = {}) {
    const d = doc.data;
    const upgraded = [];
    const waiting = [];
    const pending = [];
    const id = d.templateId;
    const version = d.version;
    const newest = id && templates.versions(id)[0];
    if (d.autoUpgrade === 'off' || !newest || newest.version !== version) return { upgraded, waiting };
    const was = new Set(d.pending || []);
    for (const o of overlays.list()) {
      const pin = o.data.template;
      if (pin.id !== id || compareVersions(pin.version, version) >= 0) continue;
      if (pendingOnly && !was.has(o.id)) continue;
      const own = templates.get(pin.id, pin.version);
      if (d.claim !== id && own && !sameOrigin(own.receipt?.source, d)) continue; // installed from elsewhere since
      const slug = o.data.slug;
      const wait = (why, run, level = 'warn') => {
        waiting.push({ overlay: slug, from: pin.version, to: version, why });
        if (announce) log[level]('a template update waits', { overlay: slug, from: pin.version, to: version, why, ...(run ? { run } : {}) });
      };
      if (onAir(o.id)) {
        pending.push(o.id);
        wait('its show is live; it moves at the first check after', undefined, 'info');
        continue;
      }
      try {
        const plan = await overlays.upgrade(slug, version, { dryRun: true });
        if (plan.confirm) {
          wait(plan.major ? 'a major version' : 'it drops settings or scenes', `skp overlay upgrade ${slug} --to ${version}`);
          continue;
        }
        if (plan.migrated === 'skipped') {
          wait('it ships a migrate.js, which runs only when you allow it', `skp overlay upgrade ${slug} --to ${version} --run-migrate`);
          continue;
        }
        await overlays.upgrade(slug, version);
        upgraded.push({ overlay: slug, from: pin.version, to: version });
        log.info('overlay upgraded to its template\'s new version', { overlay: slug, from: pin.version, to: version, source: d.label });
        record('overlay.upgrade', { overlay: slug, from: pin.version, to: version, source: d.label, automatic: true });
      } catch (err) {
        wait(err.message);
      }
    }
    update(doc, { pending: pending.length ? pending : undefined });
    return { upgraded, waiting };
  }

  return {
    add,
    remove,
    list: () => [...all()],
    get: find,
    check,
    // Checks every source after firstCheckMs, then every `minutes` (0: never).
    start(minutes) {
      if (!minutes || stopped) return;
      const next = (ms) => {
        timer = setTimeout(() => {
          check().catch(() => {}).finally(() => { if (!stopped) next(minutes * max.minuteMs); });
        }, ms);
        timer.unref?.();
      };
      next(max.firstCheckMs);
    },
    // Stops checking; a check in progress is abandoned (what it downloaded is removed). Resolves
    // once it has.
    stop() {
      stopped = true;
      clearTimeout(timer);
      stopping.abort();
      return chain;
    },
  };
}
