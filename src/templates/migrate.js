// A template's migrate.js (04 §4.10): `migrate(fromVersion, settings) → settings`, for renames a
// plain copy can't follow. It is template code running on the server, so it runs with nothing to
// reach:
//   - in a vm context of its own, with no require, process, console, timers or network, and only
//     JSON crossing in and out, so no object (or constructor) from the platform's realm is ever
//     within its reach;
//   - inside a worker thread with small memory limits, killed after a deadline, so an endless
//     loop or a memory bomb ends the worker, never the server;
//   - synchronously: it must return the settings, not a promise.
// A vm context alone is not a security boundary; the worker and the JSON-only interface are what
// keep this safe enough for code the owner chose to install (07 §7.1).
import vm from 'node:vm';
import { Worker } from 'node:worker_threads';

export class MigrateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MigrateError';
  }
}

const LIMITS = { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8, codeRangeSizeMb: 8, stackSizeMb: 2 };
// The settings migrate.js returns, as JSON: more than an overlay may save is refused before it is
// parsed (the platform then refuses anything over SAVED_BYTES anyway).
export const MAX_RESULT_CHARS = 64 * 1024;

// migrate.js as a classic script (vm runs scripts, not modules). Source that compiles as it is runs
// as it is: `function migrate`, or CommonJS-style `module.exports`. Otherwise each line that starts
// with `export function migrate(` or `export default function [name](` becomes a plain declaration
// (a named default is then bound to migrate too). Text inside comments and strings is only touched
// when the source doesn't compile without it.
export function classicMigrate(code) {
  const src = String(code);
  if (compiles(src)) return src;
  const names = [];
  const out = src
    .replace(/^([ \t]*)export[ \t]+default[ \t]+function[ \t]*([A-Za-z_$][\w$]*)?[ \t]*\(/gm, (_, indent, name) => {
      if (name && name !== 'migrate') names.push(name);
      return `${indent}function ${name || 'migrate'}(`;
    })
    .replace(/^([ \t]*)export[ \t]+function[ \t]+migrate[ \t]*\(/gm, '$1function migrate(');
  return names.length ? `${out}\n;var migrate = ${names[names.length - 1]};\n` : out;
}

// Why migrate.js can't run, or undefined: { code: 'migrate-import' | 'migrate-syntax', message }.
// Only the parser decides: a word in a comment or a string is not an import.
export function migrateProblem(code) {
  const src = String(code);
  const error = compileError(src);
  if (error && /import statement outside a module|Cannot use 'import\.meta'/.test(error)) {
    return { code: 'migrate-import', message: 'migrate.js can\'t import anything; it runs with no I/O.' };
  }
  const rewritten = compileError(classicMigrate(src));
  if (!rewritten) return undefined;
  const hint = /^[ \t]*export\b/m.test(src)
    ? ' It runs as a classic script: define function migrate(fromVersion, settings), or begin a line with `export function migrate(` or `export default function`.'
    : '';
  return { code: 'migrate-syntax', message: `migrate.js doesn't compile: ${rewritten}.${hint}` };
}

function compiles(src) {
  return compileError(src) === undefined;
}

function compileError(src) {
  try {
    new vm.Script(src, { filename: 'migrate.js' }); // eslint-disable-line no-new
    return undefined;
  } catch (err) {
    return err.message;
  }
}

// Runs inside the worker.
const RUNNER = `
const { parentPort, workerData } = require('node:worker_threads');
const vm = require('node:vm');
const { code, fromVersion, settingsJson, timeoutMs, maxChars } = workerData;
try {
  const context = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
  vm.runInContext('var module = { exports: {} }; var exports = module.exports;', context);
  vm.runInContext(code, context, { filename: 'migrate.js', timeout: timeoutMs });
  const json = vm.runInContext(
    '(function () {' +
    '  var fn = typeof migrate === "function" ? migrate : typeof module.exports === "function" ? module.exports : module.exports.migrate || module.exports.default;' +
    '  if (typeof fn !== "function") throw new Error("migrate.js must define migrate(fromVersion, settings)");' +
    '  var out = fn(' + JSON.stringify(fromVersion) + ', JSON.parse(' + JSON.stringify(settingsJson) + '));' +
    '  if (out && typeof out.then === "function") throw new Error("migrate must return the settings, not a promise");' +
    '  return JSON.stringify(out);' +
    '})()', context, { filename: 'migrate.js', timeout: timeoutMs });
  if (typeof json === 'string' && json.length > maxChars) throw new Error('it returned more settings than an overlay can save');
  parentPort.postMessage({ ok: true, json: typeof json === 'string' ? json : null });
} catch (err) {
  parentPort.postMessage({ ok: false, message: String(err && err.message || err).slice(0, 500) });
}
`;

// Resolves to the migrated settings object; rejects with MigrateError.
export function runMigrate(code, fromVersion, settings, { timeoutMs = 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(RUNNER, {
      eval: true,
      workerData: { code: classicMigrate(code), fromVersion: String(fromVersion), settingsJson: JSON.stringify(settings ?? {}), timeoutMs, maxChars: MAX_RESULT_CHARS },
      resourceLimits: LIMITS,
      env: {}, // nothing from the platform's environment, even to the runner
      stdout: true,
      stderr: true,
    });
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      worker.terminate().catch(() => {});
      fn(value);
    };
    // The vm timeout covers synchronous code; this covers everything else.
    const deadline = setTimeout(() => finish(reject, new MigrateError(`migrate.js took longer than ${timeoutMs * 3} ms`)), timeoutMs * 3);
    worker.on('message', (msg) => {
      if (!msg.ok) return finish(reject, new MigrateError(`migrate.js failed: ${msg.message}`));
      let out;
      try {
        if (typeof msg.json === 'string' && msg.json.length > MAX_RESULT_CHARS) throw new Error('too large');
        out = msg.json === null ? undefined : JSON.parse(msg.json);
      } catch {
        out = undefined;
      }
      if (out === null || typeof out !== 'object' || Array.isArray(out)) return finish(reject, new MigrateError('migrate.js must return the settings as an object'));
      finish(resolve, out);
    });
    worker.on('error', (err) => {
      const oom = err && err.code === 'ERR_WORKER_OUT_OF_MEMORY';
      finish(reject, new MigrateError(oom ? 'migrate.js ran out of memory' : `migrate.js failed: ${err && err.message}`));
    });
    worker.on('exit', (code) => finish(reject, new MigrateError(`migrate.js stopped (exit ${code})`)));
  });
}
