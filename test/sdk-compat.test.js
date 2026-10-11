// OBS 30's browser is Chromium 103. CI's browsers are far newer and the VM tests run on Node 24,
// so neither notices a newer API slipping in. This static check does: it rejects JavaScript and
// CSS that Chromium 103 lacks, plus things the overlay CSP or the sandboxed preview forbid, in the
// SDK, the mock data and every bundled template (10 §10.2, 04 §4.8).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

function files(dir, exts) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p, exts));
    else if (exts.includes(path.extname(name))) out.push(p);
  }
  return out;
}

// Comments may mention what they avoid; only code counts.
const stripJs = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/.*$/gm, '$1');
const stripCss = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');

// [pattern, what, first Chromium that has it]
const JS_DENY = [
  [/\.(toSorted|toReversed|toSpliced)\(/, 'Array copy methods', 110],
  [/\b(Object|Map)\.groupBy\b/, 'groupBy', 117],
  [/\bArray\.fromAsync\b/, 'Array.fromAsync', 121],
  [/\bPromise\.(withResolvers|try)\b/, 'Promise.withResolvers / Promise.try', 119],
  [/\.(union|intersection|difference|symmetricDifference|isSubsetOf|isSupersetOf|isDisjointFrom)\(/, 'Set methods', 122],
  [/\bIterator\.from\b|\.values\(\)\.(map|filter|take|drop|flatMap|reduce|toArray)\(/, 'iterator helpers', 122],
  [/\.(isWellFormed|toWellFormed)\(/, 'well-formed string methods', 111],
  [/\bAbortSignal\.(any|timeout)\b/, 'AbortSignal.any / AbortSignal.timeout', 116],
  [/\bResponse\.json\(/, 'static Response.json', 105],
  [/\.bytes\(\)/, 'Body.bytes()', 132],
  [/\bURL\.(canParse|parse)\(/, 'URL.canParse / URL.parse', 120],
  [/\bfor\s+await\s*\(/, 'for await (async iteration of streams)', 124],
  [/\.checkVisibility\(/, 'Element.checkVisibility', 105],
  [/\bstartViewTransition\b/, 'View Transitions', 111],
  [/\bscheduler\.(yield|postTask)\b/, 'scheduler API', 129],
  [/\.overallProgress\b/, 'Animation.overallProgress', 133],
  [/\b(RegExp\.escape|fromBase64|toBase64|fromHex|toHex)\b/, 'base64 / RegExp.escape built-ins', 136],
  [/\bTemporal\./, 'Temporal', 144],
  [/\bError\.isError\b|\bFloat16Array\b/, 'Error.isError / Float16Array', 134],
  [/\b(await\s+)?using\s+[A-Za-z_$][\w$]*\s*=/, 'using declarations', 134],
  [/^\s*(import|export)\s/m, 'module syntax (the SDK is a classic script)', 0],
];

const CSP_DENY = [
  [/\beval\s*\(|\bnew\s+Function\b|\bFunction\s*\(/, 'string-to-code (no unsafe-eval)'],
  [/\bset(Timeout|Interval)\s*\(\s*['"`]/, 'string timers (no unsafe-eval)'],
  [/\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b|document\.cookie|\bcaches\./, 'storage (throws in the sandboxed preview, H15)'],
  [/\bcrypto\.(randomUUID|subtle)\b|navigator\.(locks|clipboard|storage|serviceWorker)\b/, 'secure-context APIs (LAN mode is plain HTTP)'],
  [/credentials:\s*['"]include['"]|\bsendBeacon\b/, 'credentialed requests'],
  [/\bnew\s+(WebSocket|EventSource|Worker|SharedWorker)\b/, 'other connections or workers'],
  [/\.on(load|error|click)\s*=\s*['"`]|setAttribute\(\s*['"]on/, 'inline event handlers'],
];

const CSS_DENY = [
  [/:has\(/, ':has()', 105],
  [/@container\b|\bcq[whib]\b|\bcqmin\b|\bcqmax\b/, 'container queries', 105],
  [/\bcolor-mix\(|\b(ok)?lch\(|\b(ok)?lab\(|\blight-dark\(/, 'modern colour functions', 111],
  [/@scope\b|@starting-style\b|\btransition-behavior\b/, '@scope / @starting-style', 117],
  [/\btext-wrap\s*:/, 'text-wrap', 114],
  [/(^|[;{\s])(translate|rotate|scale)\s*:/, 'individual transform properties (use transform)', 104],
  [/\(\s*(min-|max-)?(width|height)\s*[<>]=?/, 'media query range syntax', 104],
  [/\d(svh|lvh|dvh|svw|lvw|dvw)\b/, 'small/large/dynamic viewport units', 108],
  [/\banchor-name\b|\bposition-anchor\b/, 'anchor positioning', 125],
  [/(^|[^-])background-clip\s*:\s*text/, 'unprefixed background-clip: text (use -webkit-)', 120],
  [/\bbackdrop-filter\b|\bmix-blend-mode\b/, 'backdrop-filter / mix-blend-mode on overlays (H10)', 0],
];

const sdk = files(path.join(root, 'src', 'sdk'), ['.js']);
const templateJs = files(path.join(root, 'templates'), ['.js']);
const templateCss = files(path.join(root, 'templates'), ['.css']);

for (const file of [...sdk, ...templateJs]) {
  const rel = path.relative(root, file);
  test(`${rel} uses only JavaScript that Chromium 103 has and the overlay CSP allows`, () => {
    const code = stripJs(readFileSync(file, 'utf8'));
    for (const [re, what, since] of JS_DENY) {
      if (what.startsWith('module syntax') && !rel.startsWith('src')) continue;
      assert.doesNotMatch(code, re, `${rel} uses ${what} (Chromium ${since})`);
    }
    for (const [re, what] of CSP_DENY) assert.doesNotMatch(code, re, `${rel} uses ${what}`);
  });
}

for (const file of templateCss) {
  const rel = path.relative(root, file);
  test(`${rel} uses only CSS that Chromium 103 has`, () => {
    const css = stripCss(readFileSync(file, 'utf8'));
    for (const [re, what, since] of CSS_DENY) assert.doesNotMatch(css, re, `${rel} uses ${what}${since ? ` (Chromium ${since})` : ''}`);
    assert.doesNotMatch(css, /&\s*[:.[#\w>~+]/, `${rel} uses CSS nesting (Chromium 112)`);
  });
}

test('the inline styles sk.js writes avoid post-103 and H10 CSS', () => {
  const code = stripJs(readFileSync(path.join(root, 'src', 'sdk', 'sk.js'), 'utf8'));
  const styles = (code.match(/cssText\s*=\s*([^;]+);/g) || []).join('\n');
  assert.ok(styles.length > 0);
  for (const [re, what] of CSS_DENY) assert.doesNotMatch(styles, re, `sk.js inline style uses ${what}`);
});

test('the guard itself catches what it should', () => {
  const hits = (code) => JS_DENY.concat(CSP_DENY).filter(([re]) => re.test(stripJs(code))).map(([, what]) => what);
  assert.deepEqual(hits('const s = AbortSignal.any([a, b]);'), ['AbortSignal.any / AbortSignal.timeout']);
  assert.deepEqual(hits('xs.toSorted()'), ['Array copy methods']);
  assert.deepEqual(hits('localStorage.getItem("x")'), ['storage (throws in the sandboxed preview, H15)']);
  assert.deepEqual(hits('// AbortSignal.any is not in 103\nconst ok = 1;'), []);
});
