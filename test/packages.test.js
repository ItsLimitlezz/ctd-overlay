// Package validation (04 §4.11) and the build hash (04 §4.5): what a template package must be,
// each finding with its code and where it is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildOf, packageFromDir, packageFromZip } from '../src/templates/package.js';
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
