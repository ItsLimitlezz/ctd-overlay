// GitHub in words, for Settings → Integrations and the Templates page's install (04 §4.13): which
// token the platform reads GitHub with, a repository's test with its releases to pick from, and a
// problem GitHub's token fixes, with a link to where to connect it.
//
//   GET /api/v1/integrations/github                                  which token is used
//   GET /api/v1/integrations/github/repos/:owner/:name/releases      can it be read, its releases
import * as api from './api.js';
import { badge, bytes, h, mount, notice, run } from './dom.js';

export const CONNECT_ROUTE = '#/settings/integrations';

const USING = {
  saved: 'Using the token saved here',
  env: 'Using SKP_GITHUB_TOKEN from the server\'s environment',
  none: 'Not connected: public repositories only',
};
export const usingText = (status) => USING[status?.using] || USING.none;

// A problem as a notice. One a GitHub token fixes (the problem's fix: "connect-github") links to
// Settings → Integrations, unless that is where it shows (here). onLink: the link was followed
// (a dialog closes).
export function problemNotice(err, { here = false, onLink } = {}) {
  const fix = err?.body?.fix === 'connect-github' && !here;
  return notice(h('span', err?.message || String(err), fix ? [' ', h('a', { href: CONNECT_ROUTE, onclick: () => onLink?.() }, 'Connect GitHub in Settings')] : null), 'danger');
}

// owner/name from what someone typed (owner/name, owner/name@tag, a github.com link), else undefined.
export function repoOf(text) {
  const s = String(text || '').trim();
  const m = /^(?:github:)?([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?(?:@.+)?$/.exec(s);
  if (m) return `${m[1]}/${m[2]}`;
  try {
    const u = new URL(s);
    const parts = u.hostname === 'github.com' ? u.pathname.split('/').filter(Boolean) : [];
    if (parts.length >= 2) return `${parts[0]}/${parts[1].replace(/\.git$/, '')}`;
  } catch { /* not a link */ }
  return undefined;
}

// The link that installs a release's file: its download link, which the platform reads through
// GitHub's API with the token (a private repository too). No file: the release by its tag.
const choiceUrl = (repo, tag, asset) => (asset
  ? `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(asset)}`
  : `${repo}@${tag}`);

function day(iso) {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return '';
  try { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(d); } catch { return d.toDateString(); }
}

let seq = 0;

// "Test" for a repository field: whether the platform can read it, as whom, and its releases,
// newest first. pick: choose a release and its file, to install (onChange({ url, label, repo }),
// or undefined when nothing is chosen). here: on Settings → Integrations (no link to itself).
// Returns { button, results, reset(), choice() }.
export function repoTest({ input, pick = false, onChange, here = false, onLink }) {
  const results = h('div.stack', { 'aria-live': 'polite' });
  const button = h('button.btn', { type: 'button' }, 'Test');
  let chosen;
  let asked = 0;
  const set = (c) => { chosen = c; onChange?.(c); };

  function reset() {
    asked += 1;
    mount(results);
    if (chosen) set(undefined);
  }

  function releaseText(r) {
    return [r.name && r.name !== r.tag ? r.name : null, r.publishedAt && !r.draft ? day(r.publishedAt) : null, r.assets.length ? `${r.assets.length} file${r.assets.length === 1 ? '' : 's'}` : 'no .zip attached'].filter(Boolean).join(' · ');
  }
  const flags = (r) => [r.prerelease ? badge('Pre-release', 'warn') : null, r.draft ? badge('Draft') : null];

  function show(out) {
    const who = out.login ? ` as @${out.login}` : out.using === 'env' ? ' with the server\'s token' : ' without a token';
    const head = notice(`Can read ${out.repo} (${out.private ? 'private' : 'public'})${who}.`, 'ok');
    const list = Array.isArray(out.releases) ? out.releases : [];
    if (!list.length) {
      mount(results, head, h('p.muted', 'It has no releases yet. Publish one on GitHub with the template\'s .zip attached.'));
      return;
    }
    if (!pick) {
      mount(results, head, h('ul.list', list.map((r) => h('li', h('div.grow',
        h('div.row', h('strong', r.tag), flags(r)),
        h('div.small.muted', releaseText(r)),
        r.assets.length ? h('div.small', r.assets.map((a) => a.name).join(', ')) : null)))));
      return;
    }
    const group = `rel-${++seq}`;
    const files = h('div');
    const rows = list.map((r) => {
      const radio = h('input', { type: 'radio', name: group, value: r.tag });
      radio.addEventListener('change', () => { if (radio.checked) chooseRelease(r); });
      const row = h('label.field.check', radio, h('span', h('strong', r.tag), ' ', flags(r), h('br'), h('span.hint', releaseText(r))));
      row.style.marginBottom = '4px';
      return { r, radio, row };
    });
    function chooseRelease(r) {
      const assets = r.assets;
      if (!assets.length) {
        mount(files, h('p.small.muted', 'This release has no .zip or .skp attached: its source code is installed, which works when template.json is at the repository\'s root.'));
        set({ url: choiceUrl(out.repo, r.tag), label: `${out.repo} ${r.tag}`, repo: out.repo });
        return;
      }
      const fileGroup = `file-${++seq}`;
      const radios = assets.map((a) => {
        const radio = h('input', { type: 'radio', name: fileGroup, value: a.name, checked: assets.length === 1 });
        radio.addEventListener('change', () => { if (radio.checked) set({ url: choiceUrl(out.repo, r.tag, a.name), label: `${a.name} from ${r.tag}`, repo: out.repo }); });
        const row = h('label.field.check', radio, h('span', a.name, h('br'), h('span.hint', bytes(a.size))));
        row.style.marginBottom = '4px';
        return row;
      });
      mount(files, h('fieldset', h('legend', `File from ${r.tag}`), radios));
      if (assets.length === 1) set({ url: choiceUrl(out.repo, r.tag, assets[0].name), label: `${assets[0].name} from ${r.tag}`, repo: out.repo });
      else set(undefined);
    }
    mount(results, head, h('fieldset', h('legend', 'Release'), rows.map((x) => x.row)), files);
    // The newest published release, ready to install; any other is a tap away.
    const first = rows.find((x) => !x.r.prerelease && !x.r.draft) || rows[0];
    first.radio.checked = true;
    chooseRelease(first.r);
  }

  button.addEventListener('click', async () => {
    const repo = repoOf(input.value);
    reset();
    if (!repo) {
      mount(results, notice('Enter a GitHub repository as owner/name, like ItsLimitlezz/miamiorbust-live.', 'danger'));
      return;
    }
    const mine = asked;
    const [owner, name] = repo.split('/');
    mount(results, h('p.muted', `Asking GitHub about ${repo}…`));
    const out = await run(button, () => api.get(`/api/v1/integrations/github/repos/${api.seg(owner)}/${api.seg(name)}/releases`), {
      onError: (err) => { if (mine === asked) mount(results, problemNotice(err, { here, onLink })); },
    });
    if (out && mine === asked) show(out);
  });
  return { button, results, reset, choice: () => chosen };
}
