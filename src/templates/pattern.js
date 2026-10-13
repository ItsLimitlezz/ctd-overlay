// A template's `pattern` runs on the server. A regular expression can backtrack for hours on a
// crafted value of a few dozen characters, and no shape rule catches every such pattern; nothing
// in JavaScript can stop a RegExp, but a vm timeout can (V8 interrupts the matcher). So each check
// has a deadline and each validation a budget: a pattern too slow for a value refuses that value
// ("couldn't be checked in time") instead of stalling every overlay.
//
// The budget is CPU time, not time on the clock: a streaming PC encoding video may not run this
// thread for tens of milliseconds, and a valid value must not be refused (or silently replaced by
// its default) because the machine was busy. A check that hit its deadline having barely run gets
// a longer one; only a pattern that actually burns its budget is refused.
import vm from 'node:vm';
import { SchemaError } from '../schema.js';

export const PATTERN_MS = 20; // one check's first deadline
export const PATTERN_BUDGET_MS = 100; // CPU time for every check in one validation
const MAX_WAIT_MS = 1280; // the longest deadline a starved check is given

const RUN = new vm.Script('test(p, s)');
let sandbox;

function context() {
  if (!sandbox) {
    sandbox = vm.createContext({ p: '', s: '' }, { codeGeneration: { strings: false, wasm: false } });
    new vm.Script(`
      const cache = new Map();
      globalThis.test = (p, s) => {
        let re = cache.get(p);
        if (!re) {
          if (cache.size > 500) cache.clear();
          re = new RegExp(p, 'u');
          cache.set(p, re);
        }
        return re.test(s);
      };`).runInContext(sandbox);
  }
  return sandbox;
}

function runInSandbox(pattern, value, timeout) {
  const ctx = context();
  ctx.p = pattern;
  ctx.s = value;
  try {
    return RUN.runInContext(ctx, { timeout }) === true;
  } finally {
    ctx.p = '';
    ctx.s = '';
  }
}

// This thread's CPU time, in ms (not the process's: other threads' work isn't this check's).
const cpuNow = () => {
  const { user, system } = typeof process.threadCpuUsage === 'function' ? process.threadCpuUsage() : process.cpuUsage();
  return (user + system) / 1000;
};

// A match(pattern, string) for validate(): true, false, or null when the check ran out of time.
// One per validation: the budget is shared by every check it makes. (run, cpu and wall are for
// tests.)
export function boundedMatch({ perCheckMs = PATTERN_MS, budgetMs = PATTERN_BUDGET_MS, run = runInSandbox, cpu = cpuNow, wall = () => performance.now() } = {}) {
  let left = budgetMs;
  return (pattern, value) => {
    // The first deadline is within what is left; a starved check's longer ones are time it
    // waits, which costs no budget.
    let deadline = Math.min(perCheckMs, left);
    while (left > 0) {
      const cpu0 = cpu();
      const wall0 = wall();
      try {
        const matched = run(pattern, value, Math.max(1, Math.ceil(deadline)));
        left -= cpu() - cpu0;
        return matched;
      } catch (err) {
        if (!err || err.code !== 'ERR_SCRIPT_EXECUTION_TIMEOUT') throw new SchemaError(`the pattern ${pattern} is not a valid regular expression`);
        const used = cpu() - cpu0;
        left -= used;
        // Out of time having used less than half of it: the thread was kept waiting, not the
        // pattern working. Try again with a longer deadline.
        const starved = used < (wall() - wall0) / 2;
        if (!starved || deadline >= MAX_WAIT_MS) return null;
        deadline = Math.min(deadline * 2, MAX_WAIT_MS);
      }
    }
    return null;
  };
}
