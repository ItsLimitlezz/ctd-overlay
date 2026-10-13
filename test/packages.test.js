// Package validation (04 §4.11) and the build hash (04 §4.5): what a template package must be,
// each finding with its code and where it is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildFromFiles, buildOf, packageFromDir, packageFromZip } from '../src/templates/package.js';
import { compareVersions, validateTemplate } from '../src/templates/registry.js';
import { bufferSource, writeZip } from '../src/templates/zip.js';
import { DIAG_DIR, FIXTURE_TEMPLATES, packTemplate, tempDir, TESTBED_DIR } from './helpers.js';

const codes = (result, level = 'errors') => result[level].map((f) => `${f.code} ${f.path}`).sort();
const check = (overrides) => validateTemplate(packTemplate(DIAG_DIR, overrides));

test('every bundled and fixture template validates with no errors (04 §4.11)', () => {
  const dirs = [
    ...readdirSync(new URL('../templates/', import.meta.url)).map((n) => path.join(path.dirname(DIAG_DIR), n)),
    ...readdirSync(FIXTURE_TEMPLATES).map((n) => path.join(FIXTURE_TEMPLATES, n)),
  ].filter((d) => statSync(d).isDirectory());
  assert.ok(dirs.length >= 2);
  for (const dir of dirs) assert.deepEqual(validateTemplate(dir).errors, [], dir);
  assert.deepEqual(validateTemplate(DIAG_DIR).warnings, []);
});

test('a package and the directory it was made from have the same build, on every OS', () => {
  const fromDir = validateTemplate(DIAG_DIR).build;
  assert.match(fromDir, /^[0-9a-f]{16}$/);
  assert.equal(validateTemplate(packTemplate(DIAG_DIR)).build, fromDir);
  // Inside a wrapping folder (the 04 §4.1 tree; macOS Finder's Compress) it is the same package.
  assert.equal(validateTemplate(packTemplate(DIAG_DIR, { wrap: 'diagnostic' })).build, fromDir);
  // Any change, a new build.
  assert.notEqual(validateTemplate(packTemplate(DIAG_DIR, { files: { 'extra.txt': 'x' } })).build, fromDir);
});

test('the build hash can\'t be fooled by moving bytes between a path and a file', () => {
  const tree = (files) => {
    const zip = writeZip(Object.entries(files).map(([name, data]) => ({ name, data })));
    return buildOf(packageFromZip(bufferSource(zip))).build;
  };
  // With path\0content\0 concatenated, these two trees hashed the same.
  assert.notEqual(tree({ a: 'X\0b\0Y' }), tree({ a: 'X', b: 'Y' }));
  // A golden value: the same two files hash the same everywhere.
  assert.equal(tree({ 'index.html': '<p>hi</p>', 'a/b.css': 'p{}' }), tree({ 'a/b.css': 'p{}', 'index.html': '<p>hi</p>' }));
});

test('the build is SHA-256 over one line "path\\0sha256(content)\\n" a file, paths in UTF-8 byte order, first 16 hex digits (golden values)', () => {
  const sha256 = (data) => createHash('sha256').update(data).digest('hex');
  const ascii = { 'index.html': '<p>hi</p>', 'a/b.css': 'p{}', 'a-b.css': 'q{}', 'B.css': 'r{}' };
  // "｡" (U+FF61, EF BD A1 in UTF-8) sorts before "😀" (U+1F600, F0 9F 98 80) by byte, as in any
  // language's byte comparison, though JavaScript's UTF-16 comparison puts the surrogate pair
  // (0xD83D…) first.
  const unicode = { ...ascii, '｡.css': 's{}', '😀.css': 't{}' };
  const cases = [
    // Bytes put "B" before "a" and "-" before "/"; localeCompare and sorting each directory's
    // entries (a directory walk) don't.
    [ascii, ['B.css', 'a-b.css', 'a/b.css', 'index.html'], '6d1f4a6fe7f8bb2d'],
    [unicode, ['B.css', 'a-b.css', 'a/b.css', 'index.html', '｡.css', '😀.css'], '19214b427a01864f'],
  ];
  for (const [files, order, golden] of cases) {
    // Computed here from the rule, and fixed: any other implementation must get these too.
    assert.equal(sha256(order.map((p) => `${p}\0${sha256(files[p])}\n`).join('')).slice(0, 16), golden);
    const zip = writeZip(Object.entries(files).map(([name, data]) => ({ name, data })));
    assert.equal(buildOf(packageFromZip(bufferSource(zip))).build, golden);
    const digests = Object.entries(files).map(([p, data]) => ({ path: p, sha256: sha256(data) }));
    assert.equal(buildFromFiles(digests), golden);
    assert.equal(buildFromFiles(digests.reverse()), golden);
  }
});

test('manifest problems are errors with a code and a JSON pointer', () => {
  assert.deepEqual(codes(check({ manifest: { standard: 'skp/2' } })), ['unsupported-standard /standard']);
  assert.deepEqual(codes(check({ manifest: { id: 'Diag' } })), ['manifest-invalid /id']);
  assert.deepEqual(codes(check({ files: { 'template.json': '{ "id": "x", }' } })).map((c) => c.split(' ')[0]), ['manifest-json']);
  assert.match(check({ files: { 'template.json': '{\n  "id": "x",\n}' } }).errors[0].message, /line 3, column 1/);
  assert.deepEqual(codes(check({ files: { 'template.json': undefined } })), ['manifest-missing template.json']);
  assert.deepEqual(codes(check({ manifest: { previews: ['previews/missing.png'] } })), ['file-missing /previews/0']);
  assert.deepEqual(codes(check({ manifest: { previews: ['../escape.png'] } })), ['path-invalid /previews/0']);
  assert.deepEqual(codes(check({ manifest: { entry: 'https://x.example/index.html' } })), ['path-invalid /entry']);
  assert.deepEqual(codes(check({ manifest: { entry: 'template.css' } })), ['entry-not-html /entry']);
  assert.match(check({ manifest: { entry: 'INDEX.HTML' } }).errors[0].message, /case-sensitive/);
  // A BOM (Windows PowerShell 5.1) is fine.
  const json = JSON.stringify({ ...JSON.parse(packageFromDir(DIAG_DIR).read('template.json')), name: 'BOM' });
  assert.deepEqual(check({ files: { 'template.json': `﻿${json}` } }).errors, []);
});

test('scenes, actions, transitions, consumes and fonts are checked', () => {
  const scenes = (list, extra = {}) => check({ manifest: { scenes: list, ...extra } });
  assert.deepEqual(codes(scenes([{ id: 'a', label: 'A' }, { id: 'a', label: 'A2' }])), ['duplicate-id /scenes/1/id']);
  assert.deepEqual(codes(scenes([{ id: 'a', label: 'A', durationMs: 1000, then: 'nope' }])), ['then-unknown /scenes/0/then']);
  assert.deepEqual(codes(scenes([{ id: 'a', label: 'A', durationMs: 1000, then: 'a' }])), ['then-loop /scenes/0/then']);
  assert.deepEqual(codes(scenes([{ id: 'a', label: 'A', durationMs: 0, then: 'b' }, { id: 'b', label: 'B', durationMs: 0, then: 'a' }])), ['then-loop /scenes']);
  assert.deepEqual(codes(scenes([{ id: 'a', label: 'A', durationMs: 1000 }]), 'warnings'), ['duration-without-then /scenes/0/durationMs']);
  assert.deepEqual(codes(scenes([{ id: 'program', label: 'P', core: 'program' }], { category: 'show' })), [
    'core-scene-missing /scenes', 'core-scene-missing /scenes', 'core-scene-missing /scenes',
  ]);
  assert.deepEqual(codes(check({ manifest: { actions: [{ id: 'x', label: 'X' }, { id: 'x', label: 'Y' }] } })), ['duplicate-id /actions/1/id']);
  assert.deepEqual(codes(check({ manifest: { transitions: [{ id: 'cut' }] } })), ['transition-reserved /transitions/0/id']);
  assert.deepEqual(codes(check({ manifest: { transitions: [{ id: 's', media: 'assets/nope.webm' }] } })), ['file-missing /transitions/0/media']);
  assert.deepEqual(codes(check({ manifest: { transitions: [{ id: 's', media: 'a.mov' }] }, files: { 'a.mov': 'x' } }), 'warnings'), ['media-mov /transitions/0/media']);
  assert.deepEqual(codes(check({ manifest: { consumes: { state: ['viewers..total'] } } })), ['consumes-invalid /consumes/state']);
  assert.deepEqual(codes(check({ manifest: { consumes: { events: ['alerts.*'] } } }), 'warnings'), ['consumes-unknown /consumes/events/0']);
  assert.deepEqual(codes(check({ manifest: { consumes: { events: ['chat.message'] } } }), 'warnings'), ['consumes-chat /consumes/events/0']);
  assert.deepEqual(codes(check({ manifest: { fonts: ['http://fonts.example/a.css'] } })), ['font-url /fonts/0']);
  assert.deepEqual(codes(check({ manifest: { mystery: 1 } }), 'warnings'), ['unknown-field /mystery']);
});

test('a scene can\'t have the name of another scene\'s core, or "then" would name two scenes', () => {
  const result = check({ manifest: { scenes: [{ id: 'main', label: 'Main', core: 'program' }, { id: 'program', label: 'P' }] } });
  assert.deepEqual(codes(result), ['scene-core-ambiguous /scenes/1/id']);
  assert.match(result.errors[0].message, /Scene "program" has the name of scene "main"'s core scene "program"/);
  // A scene named after its own core is the usual case.
  assert.deepEqual(check({ manifest: { scenes: [{ id: 'program', label: 'P', core: 'program' }, { id: 'brb', label: 'B', core: 'brb' }] } }).errors, []);
});

test('the manifest\'s arrays, ids, labels and URLs are capped (manifest-invalid)', () => {
  const n = (count, item) => Array.from({ length: count }, (_, i) => item(i));
  const x = (length, c = 'x') => c.repeat(length);
  // Each cap: where it is, and manifest fields at the cap plus `over`.
  const caps = [
    ['/scenes', (over) => ({ scenes: n(100 + over, (i) => ({ id: `s${i}`, label: `S${i}` })) })],
    ['/scenes/0/id', (over) => ({ scenes: [{ id: x(64 + over, 's'), label: 'S' }] })],
    ['/scenes/0/label', (over) => ({ scenes: [{ id: 's', label: x(80 + over) }] })],
    ['/canvases', (over) => ({ canvases: n(8 + over, (i) => ({ id: `c${i}`, width: 1920, height: 1080 })) })],
    ['/canvases/0/id', (over) => ({ canvases: [{ id: x(32 + over, 'c'), width: 1920, height: 1080 }] })],
    ['/actions', (over) => ({ actions: n(100 + over, (i) => ({ id: `a${i}`, label: `A${i}` })) })],
    ['/actions/0/id', (over) => ({ actions: [{ id: x(64 + over, 'a'), label: 'A' }] })],
    ['/actions/0/label', (over) => ({ actions: [{ id: 'a', label: x(80 + over) }] })],
    ['/consumes/state', (over) => ({ consumes: { state: n(64 + over, (i) => `custom.k${i}`) } })],
    ['/consumes/state/0', (over) => ({ consumes: { state: [`custom.${x(121 + over, 'k')}`] } })], // 128 characters
    ['/consumes/events', (over) => ({ consumes: { events: n(64 + over, (i) => `custom.e${i}`) } })],
    ['/consumes/events/0', (over) => ({ consumes: { events: [`custom.${x(121 + over, 'e')}`] } })],
    ['/fonts', (over) => ({ fonts: n(8 + over, (i) => `https://fonts.googleapis.com/css2?family=F${i}`) })],
    ['/fonts/0', (over) => ({ fonts: [`https://fonts.example/${x(2026 + over, 'f')}`] })], // 2048 characters
    ['/transitions', (over) => ({ transitions: n(32 + over, (i) => ({ id: `t${i}` })) })],
    ['/transitions/0/id', (over) => ({ transitions: [{ id: x(64 + over, 't') }] })],
    ['/previews', (over) => ({ previews: n(20 + over, () => 'previews/diagnostic.svg') })],
  ];
  for (const [where, fields] of caps) {
    assert.deepEqual(check({ manifest: fields(0) }).errors, [], `${where} at its cap`);
    assert.deepEqual(codes(check({ manifest: fields(1) })), [`manifest-invalid ${where}`], `${where} over its cap`);
  }
  // A transition has an id to be named by.
  assert.deepEqual(codes(check({ manifest: { transitions: [{ id: '' }] } })), ['manifest-invalid /transitions/0/id']);
  assert.deepEqual(check({ manifest: { transitions: [{ id: 't' }] } }).errors, []);
});

test('the entry document and stylesheets are linted (04 §4.5, §4.8, H10)', () => {
  const entry = (html) => check({ files: { 'index.html': html } });
  assert.deepEqual(codes(entry('<base href="/x/"><p>')), ['entry-base index.html']);
  assert.deepEqual(codes(entry('<script>alert(1)</script>'), 'warnings'), ['inline-script index.html']);
  assert.deepEqual(codes(entry('<div onclick="x()"></div>'), 'warnings'), ['inline-handler index.html']);
  assert.deepEqual(codes(entry('<img src="/assets/a.png">'), 'warnings'), ['absolute-url index.html']);
  assert.deepEqual(codes(entry('<!-- <base href="/"> --><p>')), []);
  const css = (text) => codes(check({ files: { 'template.css': text } }), 'warnings');
  assert.deepEqual(css('.a { backdrop-filter: blur(4px) }'), ['css-backdrop-filter template.css']);
  assert.deepEqual(css('.a { mix-blend-mode: multiply }'), ['css-blend template.css']);
  assert.deepEqual(css('.a:has(b) {}'), ['css-too-new template.css']);
  assert.deepEqual(css('/* backdrop-filter: blur() */ .a {}'), []);
  assert.deepEqual(codes(check({ files: { 'assets/Logo.PNG': 'x', 'my file.png': 'x' } }), 'warnings'), ['path-case assets/Logo.PNG', 'path-escape my file.png']);
});

test('settings schemas are checked at install; a binding must be to a declared key; durationSetting without settings is a warning', () => {
  const settings = (props, extra) => check({ manifest: { settings: { type: 'object', properties: props }, ...extra } });
  assert.deepEqual(codes(settings({ a: { type: 'string', default: 1 } })), ['settings /settings']);
  assert.deepEqual(codes(settings({ a: { type: 'string', 'x-skp-bind': 'viewers.total' } })), ['bind-undeclared /settings']);
  assert.deepEqual(settings({ a: { type: 'string', 'x-skp-bind': 'custom.headliner' } }).errors, []); // custom.* is declared
  assert.deepEqual(codes(check({ manifest: { alerts: { durationSetting: 'hold' } } }), 'warnings'), ['settings /alerts/durationSetting']);
});

test('a settings default the template\'s own pattern can\'t check in time is refused at install, without stalling it', () => {
  // ^(\w|_)+$ backtracks exponentially on a run of "_" that ends in something else: unchecked,
  // about a second for 26 (twice that for each more), many times the 20 ms deadline. Not more, so
  // that a lost deadline fails this test in seconds instead of hanging it. Measured in this
  // thread's CPU time, like the deadline: on a busy machine, waiting for a CPU isn't stalling.
  const cpu = () => {
    const { user, system } = typeof process.threadCpuUsage === 'function' ? process.threadCpuUsage() : process.cpuUsage();
    return (user + system) / 1000;
  };
  const t0 = cpu();
  const result = check({ manifest: { settings: { type: 'object', properties: { s: { type: 'string', pattern: '^(\\w|_)+$', default: `${'_'.repeat(26)}!` } } } } });
  assert.ok(cpu() - t0 < 2000, `took ${cpu() - t0} ms of CPU`);
  assert.deepEqual(codes(result), ['settings /settings']);
  assert.match(result.errors[0].message, /the default "_+!" couldn't be checked .* in time/);
  assert.match(result.warnings.map((w) => w.message).join(), /repeats a group/);
});

test('strict SemVer, length limits, layout and duplicate core scenes', () => {
  // The manifest schema's own pattern and lengths catch these (template.schema.json).
  assert.deepEqual(codes(check({ manifest: { version: '1.02.0' } })), ['manifest-invalid /version']);
  assert.deepEqual(check({ manifest: { version: '1.2.0-rc.1' } }).errors, []);
  assert.deepEqual(codes(check({ manifest: { id: `dev.skp.${'x'.repeat(100)}` } })), ['manifest-invalid /id']);
  assert.deepEqual(codes(check({ manifest: { author: { name: 'x', url: 'ftp://x.example' } } })), ['author-url /author/url']);
  assert.deepEqual(codes(check({ manifest: { scenes: [{ id: 'a', label: 'A', core: 'program' }, { id: 'b', label: 'B', core: 'program' }] } })), ['duplicate-core /scenes/1/core']);
  const nested = writeZip(packageFromDir(DIAG_DIR).names.map((n) => ({ name: `outer/inner/${n}`, data: packageFromDir(DIAG_DIR).read(n) })));
  assert.deepEqual(codes(validateTemplate(nested)), ['layout outer/inner/template.json']);
  assert.deepEqual(codes(check({ files: { 'migrate.js': 'export function migrate(v, s) { return s' } })), ['migrate-syntax migrate.js']);
});

test('migrate.js can\'t import anything', () => {
  assert.deepEqual(codes(check({ files: { 'migrate.js': 'import fs from "node:fs";\nexport function migrate(v, s) { return s; }' } })), ['migrate-import migrate.js']);
  assert.deepEqual(check({ files: { 'migrate.js': 'export function migrate(v, s) { return s; }' } }).errors, []);
});

test('migrate.js forms the runtime accepts install; the word "import" in a comment or string is not an import', () => {
  const migrate = (code) => check({ files: { 'migrate.js': code } });
  assert.deepEqual(migrate('export default function renameAll(from, s) { return s; }').errors, []);
  assert.deepEqual(migrate('/* For example:\n  export function migrate(v, s) { return {}; }\n*/\nexport function migrate(v, s) { return s; }').errors, []);
  assert.deepEqual(migrate('// nothing to import here\n/*\nimport x from "y" would be refused\n*/\nfunction migrate(v, s) { return { t: "import(" }; }').errors, []);
  assert.deepEqual(codes(migrate('import x from "y";\nexport function migrate(v, s) { return s; }')), ['migrate-import migrate.js']);
  const broken = migrate('export const migrate = (v, s) => s;');
  assert.deepEqual(codes(broken), ['migrate-syntax migrate.js']);
  assert.match(broken.errors[0].message, /classic script/);
});

test('a directory with a link in it is refused; clutter is skipped', (t) => {
  const dir = tempDir(t);
  for (const name of readdirSync(DIAG_DIR, { recursive: true })) {
    const from = path.join(DIAG_DIR, name);
    if (statSync(from).isDirectory()) mkdirSync(path.join(dir, name), { recursive: true });
    else writeFileSync(path.join(dir, name), packageFromDir(DIAG_DIR).read(name.split(path.sep).join('/')));
  }
  writeFileSync(path.join(dir, '.DS_Store'), 'junk');
  assert.equal(validateTemplate(dir).build, validateTemplate(DIAG_DIR).build);
  try {
    symlinkSync(path.join(dir, 'template.json'), path.join(dir, 'link.json'));
  } catch (err) {
    t.skip(`can't create symlinks here (${err.code})`);
    return;
  }
  assert.throws(() => packageFromDir(dir), /symbolic link/);
});

test('versions compare by SemVer precedence', () => {
  const sorted = ['1.10.0', '1.0.0', '1.0.0-rc.1', '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta.11', '1.0.0-beta.2', '0.9.9', '1.0.1'].sort(compareVersions);
  assert.deepEqual(sorted, ['0.9.9', '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.1', '1.10.0']);
  assert.equal(compareVersions('2.0.0', '2.0.0'), 0);
});

test('the testbed\'s own build matches its package', () => {
  assert.equal(validateTemplate(packTemplate(TESTBED_DIR)).build, validateTemplate(TESTBED_DIR).build);
});
