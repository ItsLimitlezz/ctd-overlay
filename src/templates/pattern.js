// A template's `pattern` runs on the server. A regular expression can backtrack for hours on a
// crafted value of a few dozen characters, and no shape rule catches every such pattern; nothing
// in JavaScript can stop a RegExp, but a vm timeout can (V8 interrupts the matcher). So each check
// has a deadline and each validation a budget: a pattern too slow for a value refuses that value
// ("couldn't be checked in time") instead of stalling every overlay.
import vm from 'node:vm';
import { SchemaError } from '../schema.js';

export const PATTERN_MS = 20; // one check
export const PATTERN_BUDGET_MS = 100; // every check in one validation

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

// A match(pattern, string) for validate(): true, false, or null when the check ran out of time.
// One per validation: the budget is shared by every check it makes.
export function boundedMatch({ perCheckMs = PATTERN_MS, budgetMs = PATTERN_BUDGET_MS } = {}) {
  let left = budgetMs;
  return (pattern, value) => {
    if (left <= 0) return null;
    const ctx = context();
    ctx.p = pattern;
    ctx.s = value;
    const start = performance.now();
    try {
      return RUN.runInContext(ctx, { timeout: Math.max(1, Math.ceil(Math.min(perCheckMs, left))) }) === true;
    } catch (err) {
      if (err && err.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') return null;
      throw new SchemaError(`the pattern ${pattern} is not a valid regular expression`);
    } finally {
      left -= performance.now() - start;
      ctx.p = '';
      ctx.s = '';
    }
  };
}
