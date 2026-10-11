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
import { Worker } from 'node:worker_threads';

export class MigrateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MigrateError';
  }
}

const LIMITS = { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8, codeRangeSizeMb: 8, stackSizeMb: 2 };

// migrate.js as a classic script: one `export function migrate` or `export default function` is
// rewritten to a plain declaration (vm runs scripts, not modules); `function migrate` and a
// CommonJS-style `module.exports` work as they are.
export function classicMigrate(code) {
  return String(code)
    .replace(/^\s*export\s+default\s+function\s*(?:migrate\s*)?\(/m, 'function migrate(')
    .replace(/^\s*export\s+function\s+migrate\s*\(/m, 'function migrate(');
}

// Runs inside the worker.
const RUNNER = `
const { parentPort, workerData } = require('node:worker_threads');
const vm = require('node:vm');
const { code, fromVersion, settingsJson, timeoutMs } = workerData;
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
      workerData: { code: classicMigrate(code), fromVersion: String(fromVersion), settingsJson: JSON.stringify(settings ?? {}), timeoutMs },
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
