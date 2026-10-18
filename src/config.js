// Configuration (10 §10.5). Precedence: command-line flags > environment variables > config.json
// > defaults. Everything is checked here, at startup; a bad value stops the process with a
// message that names the setting, where it came from, and what to change.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isIP } from 'node:net';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { normalizeIp } from './net.js';

export class ConfigError extends Error {}

// key → [environment variable, command-line flag, accepted in config.json]
const SETTINGS = {
  port: ['SKP_PORT', 'port', true],
  host: ['SKP_HOST', 'host', true],
  dataDir: ['SKP_DATA_DIR', 'data-dir', true],
  configDir: ['SKP_CONFIG_DIR', 'config-dir', false], // config.json is read from it
  exposure: ['SKP_EXPOSURE', 'exposure', true],
  publicUrl: ['SKP_PUBLIC_URL', 'public-url', true],
  tlsCert: ['SKP_TLS_CERT', 'tls-cert', true],
  tlsKey: ['SKP_TLS_KEY', 'tls-key', true],
  trustProxy: ['SKP_TRUST_PROXY', 'trust-proxy', true],
  masterKey: ['SKP_MASTER_KEY', null, false], // a secret: environment only, never a file or a flag
  masterKeyFile: ['SKP_MASTER_KEY_FILE', 'master-key-file', true],
  ffmpeg: ['SKP_FFMPEG', 'ffmpeg', true],
  logLevel: ['SKP_LOG_LEVEL', 'log-level', true],
  store: ['SKP_STORE', 'store', true],
  timezone: ['TZ', 'timezone', true],
  githubToken: ['SKP_GITHUB_TOKEN', null, false], // a secret: for template sources in private repos
  githubClientId: ['SKP_GITHUB_CLIENT_ID', null, true], // an OAuth app's id (no secret): "Sign in with GitHub"
  templateCheckMinutes: ['SKP_TEMPLATE_CHECK_MINUTES', 'template-check-minutes', true],
  allowPrivateDownloads: ['SKP_ALLOW_PRIVATE_DOWNLOADS', null, true], // the owner's choice (07 §7.11)
  auditDays: ['SKP_AUDIT_DAYS', 'audit-days', true], // how long the audit log keeps entries (07 §7.12)
  hosts: ['SKP_HOSTS', 'hosts', true], // more names the platform answers to in lan and public modes
  allowPlainInternet: ['SKP_ALLOW_PLAIN_INTERNET', null, true], // the owner's choice: lan mode also serves the internet, unencrypted
};

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];
const STORES = ['sqlite', 'json'];
const EXPOSURES = ['local', 'lan', 'public'];

export function loadConfig({ argv = process.argv.slice(2), env = process.env, platform = process.platform, home = homedir() } = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const flags = parseFlags(argv);
  const defaults = defaultDirs(platform, env, home, p);
  const warnings = [];

  const pick = (key, file = {}) => {
    const [envName, flag] = SETTINGS[key];
    if (flag && flags[flag] !== undefined) return { value: flags[flag], source: `--${flag}` };
    if (env[envName] !== undefined && env[envName] !== '') return { value: env[envName], source: envName };
    if (file[key] !== undefined) return { value: file[key], source: `config.json "${key}"` };
    return { value: undefined, source: 'default' };
  };

  const configDirPick = pick('configDir');
  const configDir = p.resolve(configDirPick.value ?? defaults.configDir);
  const file = readConfigFile(p.join(configDir, 'config.json'));
  const get = (key) => pick(key, file);

  // where things live
  const dataDir = p.resolve(get('dataDir').value ?? defaults.dataDir);
  if (isInside(configDir, dataDir, p) || isInside(dataDir, configDir, p)) {
    throw new ConfigError(
      `The config directory (${configDir}) and the data directory (${dataDir}) must be separate, neither inside the other: ` +
      'the master key lives in the config directory, and a backup of the data directory must never contain it (07 §7.7). ' +
      'Set SKP_CONFIG_DIR or SKP_DATA_DIR so they are siblings.');
  }
  // On Windows a file's mode (0600) restricts nothing: the master key and the command line's
  // token take the config directory's permissions. In the user's profile (the default) only they
  // can read it; elsewhere often anyone can (every user may read what is made under C:\).
  if (platform === 'win32' && ![home, env.LOCALAPPDATA].some((d) => d && isInside(configDir, p.resolve(d), p))) {
    warnings.push(`The config directory ${configDir} is outside your user profile. On Windows the master key and the command line's token in it can be read by anyone who can read that directory: check its permissions (icacls), or use the default, %LOCALAPPDATA%\\SKP\\config.`);
  }

  // exposure and binding (07 §7.8): local listens on this machine only; lan on every interface,
  // serving the local network; public on every interface, over TLS (its own or a trusted proxy's).
  const exposure = oneOf(get('exposure'), EXPOSURES, 'local');
  const host = str(get('host')) ?? (exposure === 'local' ? '127.0.0.1' : '0.0.0.0');
  if (exposure === 'local' && !isLoopback(host)) {
    throw new ConfigError(
      `${get('host').source} is "${host}", which would expose the server beyond this machine, but exposure is "local". ` +
      'Use 127.0.0.1, ::1 or localhost, or set SKP_EXPOSURE=lan.');
  }
  const port = parsePort(get('port'));

  // TLS and proxies
  const tlsCert = str(get('tlsCert'));
  const tlsKey = str(get('tlsKey'));
  if (Boolean(tlsCert) !== Boolean(tlsKey)) throw new ConfigError('Set both SKP_TLS_CERT and SKP_TLS_KEY (a certificate and its private key, PEM files), or neither.');
  const publicUrl = parsePublicUrl(get('publicUrl'));
  const trustProxy = parseTrustProxy(get('trustProxy'));
  if (exposure === 'public') {
    if (!tlsCert && !trustProxy.length) throw new ConfigError('SKP_EXPOSURE=public requires TLS: set SKP_TLS_CERT/KEY or SKP_TRUST_PROXY (the address of a reverse proxy that serves HTTPS).');
    if (!publicUrl) throw new ConfigError('SKP_EXPOSURE=public requires SKP_PUBLIC_URL: the https:// address people and services reach this platform at.');
  }
  const hosts = parseHosts(get('hosts'));

  // secrets
  const masterKey = parseMasterKey(get('masterKey'));
  const masterKeyFile = str(get('masterKeyFile'));
  if (masterKey && masterKeyFile) {
    throw new ConfigError('Set SKP_MASTER_KEY or SKP_MASTER_KEY_FILE, not both.');
  }

  // everything else
  const logLevel = oneOf(get('logLevel'), LOG_LEVELS, 'info');
  const store = oneOf(get('store'), STORES, 'sqlite');
  const ffmpeg = str(get('ffmpeg')) ?? 'ffmpeg';
  const timezone = parseTimezone(get('timezone'), warnings);
  const githubToken = str(get('githubToken'));
  const githubClientId = str(get('githubClientId'));
  if (githubClientId && !/^[A-Za-z0-9._-]{1,100}$/.test(githubClientId)) throw new ConfigError(`${get('githubClientId').source} must be a GitHub OAuth app's client ID, like Ov23liAbCdEf0123 (got "${githubClientId}").`);
  const templateCheckMinutes = parseMinutes(get('templateCheckMinutes'), 60);
  const allowPrivateDownloads = parseBool(get('allowPrivateDownloads'), false);
  const auditDays = parseDays(get('auditDays'), 90);
  // A router's port forward to a lan-mode platform, without TLS: requests from the internet are
  // served over plain HTTP, so passwords, sessions and overlay keys cross it unencrypted. Only in
  // lan mode (public mode has TLS, local mode listens on this machine only), and said at startup.
  const allowPlainInternet = parseBool(get('allowPlainInternet'), false);
  if (allowPlainInternet) {
    if (exposure !== 'lan') throw new ConfigError(`${get('allowPlainInternet').source} is only for SKP_EXPOSURE=lan (a port forward without HTTPS); public mode has its own TLS.`);
    warnings.push('SKP_ALLOW_PLAIN_INTERNET is on: requests from the internet are served over plain HTTP, so passwords, sessions and overlay keys cross it unencrypted. For HTTPS, put the platform behind a tunnel or proxy and use SKP_EXPOSURE=public.');
  }

  return Object.freeze({
    port, host, exposure, dataDir, configDir,
    tlsCert: tlsCert ? p.resolve(tlsCert) : undefined, tlsKey: tlsKey ? p.resolve(tlsKey) : undefined, hosts,
    publicUrl, trustProxy, masterKey, masterKeyFile: masterKeyFile ? p.resolve(masterKeyFile) : undefined,
    ffmpeg, logLevel, store, timezone, githubToken, githubClientId, templateCheckMinutes, allowPrivateDownloads, auditDays, allowPlainInternet, warnings: Object.freeze(warnings),
  });
}

// What's safe to print at startup.
export function describeConfig(config) {
  const { masterKey, githubToken, warnings, ...rest } = config;
  return { ...rest, masterKey: masterKey ? 'set' : 'not set', githubToken: githubToken ? 'set' : 'not set' };
}

function parseBool(picked, fallback) {
  const v = str(picked);
  if (v === undefined) return fallback;
  if (/^(true|1|yes)$/i.test(v)) return true;
  if (/^(false|0|no)$/i.test(v)) return false;
  throw new ConfigError(`${picked.source} must be true or false (got "${v}").`);
}

function parseDays(picked, fallback) {
  const v = str(picked);
  if (v === undefined) return fallback;
  if (!/^\d+$/.test(v) || Number(v) < 1 || Number(v) > 3650) throw new ConfigError(`${picked.source} must be a number of days from 1 to 3650 (got "${v}").`);
  return Number(v);
}

// How often template sources are checked: whole minutes, 0 (never on its own) to a week.
function parseMinutes(picked, fallback) {
  const v = str(picked);
  if (v === undefined) return fallback;
  if (!/^\d+$/.test(v) || Number(v) > 10080) {
    throw new ConfigError(`${picked.source} must be a number of minutes from 0 (never) to 10080 (a week) (got "${v}").`);
  }
  if (Number(v) > 0 && Number(v) < 5) throw new ConfigError(`${picked.source} must be 0 or at least 5 minutes: GitHub allows 60 unauthenticated requests an hour (got "${v}").`);
  return Number(v);
}

export function defaultDirs(platform, env, home, p = platform === 'win32' ? path.win32 : path.posix) {
  if (platform === 'darwin') {
    const base = p.join(home, 'Library', 'Application Support', 'SKP');
    return { dataDir: p.join(base, 'data'), configDir: p.join(base, 'config') };
  }
  if (platform === 'win32') {
    const base = p.join(env.LOCALAPPDATA || p.join(home, 'AppData', 'Local'), 'SKP');
    return { dataDir: p.join(base, 'data'), configDir: p.join(base, 'config') };
  }
  // Linux and other Unix, per user. A system install sets SKP_DATA_DIR=/var/lib/skp and
  // SKP_CONFIG_DIR=/etc/skp in its unit; the container image sets /data and /config (10 §10.3–10.4).
  return {
    dataDir: p.join(env.XDG_DATA_HOME || p.join(home, '.local', 'share'), 'skp'),
    configDir: p.join(env.XDG_CONFIG_HOME || p.join(home, '.config'), 'skp'),
  };
}

function parseFlags(argv) {
  const options = {};
  for (const [, flag] of Object.values(SETTINGS)) if (flag) options[flag] = { type: 'string' };
  try {
    return parseArgs({ args: argv, options, strict: true, allowPositionals: false }).values;
  } catch (err) {
    const known = Object.keys(options).map((f) => `--${f}`).join(', ');
    throw new ConfigError(`${err.message}. Known options: ${known}.`);
  }
}

function readConfigFile(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new ConfigError(`Can't read ${file}: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`${file} isn't valid JSON: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigError(`${file} must contain a JSON object.`);
  }
  for (const key of Object.keys(parsed)) {
    if (!(key in SETTINGS)) {
      throw new ConfigError(`${file} has an unknown setting "${key}". Known settings: ${Object.keys(SETTINGS).filter((k) => SETTINGS[k][2]).join(', ')}.`);
    }
    if (!SETTINGS[key][2]) {
      throw new ConfigError(`${file} can't set "${key}"; use the ${SETTINGS[key][0]} environment variable instead.`);
    }
  }
  return parsed;
}

function str({ value }) {
  if (value === undefined || value === null) return undefined;
  const s = String(value).trim();
  return s === '' ? undefined : s;
}

function oneOf(picked, allowed, fallback) {
  const v = str(picked);
  if (v === undefined) return fallback;
  if (!allowed.includes(v)) throw new ConfigError(`${picked.source} must be one of ${allowed.join(', ')} (got "${v}").`);
  return v;
}

function parsePort(picked) {
  const v = str(picked);
  if (v === undefined) return 4848;
  if (!/^\d+$/.test(v) || Number(v) > 65535) {
    throw new ConfigError(`${picked.source} must be a port number from 1 to 65535, or 0 for any free port (got "${v}").`);
  }
  return Number(v);
}

function isLoopback(host) {
  if (host === 'localhost' || host === '::1') return true;
  return isIP(host) === 4 && host.startsWith('127.');
}

function parsePublicUrl(picked) {
  const v = str(picked);
  if (v === undefined) return undefined;
  let url;
  try { url = new URL(v); } catch { throw new ConfigError(`${picked.source} must be a URL like https://overlays.example.com (got "${v}").`); }
  if (url.protocol !== 'https:') throw new ConfigError(`${picked.source} must use https:// (got "${v}").`);
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new ConfigError(`${picked.source} must be an origin only, with no path, query or fragment (got "${v}").`);
  }
  return url.origin;
}

// Written the way net.js writes a request's address (normalizeIp), so "::ffff:172.17.0.1" or
// "FD00:0::2" matches the peer it names.
function parseTrustProxy(picked) {
  const v = picked.value;
  if (v === undefined || v === null || v === '') return Object.freeze([]);
  const list = (Array.isArray(v) ? v : String(v).split(',')).map((s) => String(s).trim()).filter(Boolean);
  for (const addr of list) {
    if (!isIP(addr)) throw new ConfigError(`${picked.source} must list IP addresses separated by commas (got "${addr}").`);
  }
  return Object.freeze([...new Set(list.map(normalizeIp))]);
}

// Host names (and host:port) the platform also answers to: a NAS's DNS name, say.
function parseHosts(picked) {
  const v = picked.value;
  if (v === undefined || v === null || v === '') return Object.freeze([]);
  const list = (Array.isArray(v) ? v : String(v).split(',')).map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  for (const h of list) {
    if (!/^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(:\d{1,5})?$/.test(h)) throw new ConfigError(`${picked.source} must list host names separated by commas, like nas.home.arpa or 192.168.1.20 (got "${h}").`);
  }
  return Object.freeze(list);
}

function parseMasterKey(picked) {
  const v = str(picked);
  if (v === undefined) return undefined;
  if (!/^[A-Za-z0-9+/]{43}=$/.test(v) || Buffer.from(v, 'base64').length !== 32) {
    throw new ConfigError(`${picked.source} must be 32 bytes in base64 (44 characters ending in "="). Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`);
  }
  return v;
}

function parseTimezone(picked, warnings) {
  const system = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const v = str(picked);
  if (v === undefined) return system;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: v }).resolvedOptions().timeZone;
  } catch {
    // TZ in the environment is often a POSIX string (":/etc/localtime", "EST5EDT") rather than an
    // IANA name. That's the OS's business, so it only earns a warning; an explicit flag or
    // config.json value is a mistake and stops startup.
    if (picked.source === 'TZ') {
      warnings.push(`TZ="${v}" isn't an IANA time zone name; new shows default to ${system} instead.`);
      return system;
    }
    throw new ConfigError(`${picked.source} must be an IANA time zone name such as America/Toronto (got "${v}").`);
  }
}

function isInside(child, parent, p) {
  const rel = p.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !p.isAbsolute(rel));
}
