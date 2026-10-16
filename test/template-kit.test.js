// The template kit (docs/template-kit) and the bundled Chat and Alerts templates: the reference
// template validates with nothing to warn about, and installs; Chat and Alerts render sample data
// (?mock=1) in a real browser with no console error or CSP violation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startPlatform } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { packageFromDir, validatePackage } from '../src/templates/package.js';
import { browserSkip, launchBrowser } from './cdp.js';
import { defer, memoryLogger, tempDir } from './helpers.js';

const KIT = fileURLToPath(new URL('../docs/template-kit/', import.meta.url));
const TEMPLATES = fileURLToPath(new URL('../templates/', import.meta.url));

test('the reference template and the bundled Chat and Alerts templates validate with no findings', () => {
  for (const dir of [path.join(KIT, 'mega'), path.join(TEMPLATES, 'chat'), path.join(TEMPLATES, 'alerts')]) {
    const result = validatePackage(packageFromDir(dir));
    assert.deepEqual([result.errors, result.warnings], [[], []], dir);
  }
});

async function start(t) {
  const root = tempDir(t);
  const config = loadConfig({ argv: ['--port', '0'], env: { SKP_DATA_DIR: path.join(root, 'data'), SKP_CONFIG_DIR: path.join(root, 'config') } });
  const platform = await startPlatform(config, { log: memoryLogger().log, templateDirs: [KIT] });
  defer(t, () => platform.stop());
  return platform;
}

test('Chat, Alerts and the reference template render sample data in a browser', { skip: browserSkip, timeout: 120000 }, async (t) => {
  const platform = await start(t);
  for (const [slug, template] of [['chat', 'com.dprtmnt.chat'], ['alerts', 'com.dprtmnt.alerts'], ['mega', 'com.example.mega-show']]) {
    platform.overlays.create({ slug, template: { id: template, version: '1.0.0' }, settings: {} });
  }
  const browser = await launchBrowser(t);
  const open = async (slug, extra = '') => {
    const [first] = platform.overlays.urls(slug, platform.url);
    return browser.open(`${first.url}${first.url.includes('?') ? '&' : '?'}mock=1${extra}`, { width: 1920, height: 1080 });
  };

  const chat = await open('chat');
  await chat.waitFor('document.querySelectorAll(".msg").length >= 5', 15000);
  assert.ok(await chat.eval('document.querySelector(".msg .plat") !== null'), 'platform tags');
  assert.deepEqual(chat.problems, []);

  // The sample data's first alert comes 8 s in.
  const alerts = await open('alerts');
  await alerts.waitFor('document.querySelector("[data-skp-alert] .who")?.textContent.length > 0', 20000);
  assert.match(await alerts.eval('document.querySelector("[data-skp-alert]").innerText'), /RAID[\s\S]*NightRaider[\s\S]*238 viewers/);
  assert.deepEqual(alerts.problems, []);

  const mega = await open('mega', '&scene=program');
  await mega.waitFor('document.querySelectorAll(".chat .msg").length > 0 && !document.querySelector("[data-np]").hidden', 15000);
  assert.deepEqual(mega.problems, []);
  const lineup = await open('mega', '&scene=lineup');
  await lineup.waitFor('document.querySelectorAll("[data-acts] li").length > 0', 10000);
  assert.deepEqual(lineup.problems, []);
});
