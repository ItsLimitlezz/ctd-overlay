// Media (08 §8.1): the clips, images, sounds and fonts overlays use (lineup logos, a stinger, an
// intro video). Upload (POST /api/v1/media?name=<file name>, the file itself as the body), the
// list (GET /api/v1/media, newest first), Copy URL (the file's /media/<fileId>/<name> path, which
// overlay settings take) and Delete (DELETE /api/v1/media/:id, a 409 while an overlay uses it).
// Phone video is converted for OBS when the platform has ffmpeg (GET /api/v1/system/info →
// capabilities.ffmpeg, H12).
import * as api from '../api.js';
import { ago, badge, bytes, confirm, copy, dialog, empty, every, h, isPhone, menu, mount, notice, pageHead, run, toast } from '../dom.js';

// The most one file can be (src/media/library.js, 07 §7.11). Checked before sending: over it the
// server stops reading mid-upload, and the browser sees a dropped connection, not the reason.
const MAX_BYTES = 600 * 1024 * 1024;

// What the file picker offers: what the server takes (src/media/sniff.js). The server decides by
// the file's content, not its name, so a dropped file goes up whatever it is called.
const ACCEPT = [
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/heic', 'image/heif',
  'video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska', 'video/x-msvideo', 'video/3gpp',
  'audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/ogg', 'audio/flac', 'audio/wav', 'audio/x-wav',
  'font/woff2', 'font/woff', 'font/ttf', 'font/otf',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.heic', '.heif',
  '.mp4', '.m4v', '.mov', '.webm', '.mkv', '.avi', '.3gp',
  '.mp3', '.m4a', '.ogg', '.oga', '.opus', '.flac', '.wav',
  '.woff2', '.woff', '.ttf', '.otf',
].join(',');

// The filter. Fonts get one only when there are any.
const KINDS = [
  { id: 'all', label: 'All' },
  { id: 'image', label: 'Images', none: 'No images' },
  { id: 'video', label: 'Video', none: 'No videos' },
  { id: 'audio', label: 'Audio', none: 'No audio' },
  { id: 'font', label: 'Fonts', none: 'No fonts', onlyWhenAny: true },
];
const WORD = { image: 'image', video: 'video', audio: 'audio', font: 'font' };

// "VID_20261013_2130…_stabilized.mp4": a long file name in a message, cut in the middle so both
// ends still say which file it is.
const shortName = (name, max = 32) => {
  const s = String(name ?? '');
  return s.length <= max ? s : `${s.slice(0, max - 12)}…${s.slice(-11)}`;
};

const looksLikeVideo = (file) => /^video\//.test(file.type || '') || /\.(mov|mp4|m4v|mkv|avi|3gp)$/i.test(file.name || '');

// ---- uploads -------------------------------------------------------------------------------
// Uploads run here, one file at a time, rather than in the page: leaving Media while a long clip
// uploads or converts doesn't drop it, and coming back shows it still going.
const uploads = { queue: [], current: undefined, done: 0, total: 0, failures: [], listeners: new Set() };
let hasFfmpeg; // capabilities.ffmpeg, once known
let filter = 'all'; // the list's filter, kept while the app is open

function tell(type, detail = {}) {
  for (const fn of [...uploads.listeners]) {
    try { fn({ type, ...detail }); } catch (err) { console.error(err); }
  }
}

// Closing the tab mid-upload loses the file: the browser asks first.
const holdPage = (e) => {
  e.preventDefault();
  e.returnValue = '';
};

function refuse(message) {
  uploads.failures.push(message);
  toast(message, { kind: 'error' });
}

// What the server would refuse anyway, said before sending hundreds of MB for nothing.
function precheck(file) {
  if (file.size > MAX_BYTES) return `Couldn't upload ${shortName(file.name)}: it is ${bytes(file.size)}, and the most one file can be is ${bytes(MAX_BYTES)}. Trim or compress it, then upload it again.`;
  if (file.size === 0) return `Couldn't upload ${shortName(file.name)}: the file is empty.`;
  return undefined;
}

// files: File[]; refused: messages about what was dropped but can't go (a folder).
function enqueue(files, refused = []) {
  if (!files.length && !refused.length) return;
  // A new batch starts with a clean slate.
  if (!uploads.current && !uploads.queue.length) {
    uploads.done = 0;
    uploads.total = 0;
    uploads.failures = [];
  }
  for (const message of refused) refuse(message);
  for (const file of files) {
    const problem = precheck(file);
    if (problem) refuse(problem);
    else {
      uploads.queue.push(file);
      uploads.total += 1;
    }
  }
  tell('queued');
  if (uploads.queue.length) pump();
}

// What went wrong, in words: the problem's detail, or what a dropped connection means here.
function reasonOf(err) {
  // No answer, or one without a reason: the connection dropped, or the server stopped waiting for
  // a slow upload (it answers a bare 400 then, and may still keep the file). The list, which
  // reloads by itself, says whether it arrived.
  if (err?.status === 0 || err?.status === 408 || (err?.status === 400 && !err.body?.detail)) {
    return 'The connection dropped before the platform answered. If the file doesn\'t show up in the list within a minute, upload it again.';
  }
  return err?.message || 'Something went wrong. Try again.';
}

function uploadedText(file, item) {
  const name = shortName(file.name);
  if (item?.note) return `Uploaded ${name}, but OBS may not play it: see the note on it below.`;
  if (item?.converted) return `Uploaded ${name} and converted it ${item.kind === 'image' ? 'to JPEG' : 'so OBS can play it'}`;
  return `Uploaded ${name}`;
}

async function pump() {
  if (uploads.current) return;
  window.addEventListener('beforeunload', holdPage);
  try {
    while (uploads.queue.length) {
      const file = uploads.queue.shift();
      uploads.current = file;
      tell('progress');
      try {
        const item = await api.post('/api/v1/media', undefined, { raw: file, contentType: file.type || 'application/octet-stream', query: { name: file.name } });
        toast(uploadedText(file, item));
        tell('added', { item });
      } catch (err) {
        refuse(`Couldn't upload ${shortName(file.name)}. ${reasonOf(err)}`);
        // Signed out, or not allowed: the rest would fail the same way.
        if ((err?.status === 401 || err?.status === 403) && uploads.queue.length) {
          const n = uploads.queue.splice(0).length;
          uploads.failures.push(`${n} more ${n === 1 ? 'file was' : 'files were'} not uploaded.`);
        }
      } finally {
        uploads.done += 1;
      }
    }
  } finally {
    uploads.current = undefined;
    window.removeEventListener('beforeunload', holdPage);
    tell('finished');
  }
}

// The files of a drop; a folder is refused by name (its File is empty, and its contents aren't
// in the drop).
function droppedFiles(dt) {
  const files = [];
  const refused = [];
  const entries = Array.from(dt?.items || []).filter((it) => it.kind === 'file');
  if (!entries.length) return { files: Array.from(dt?.files || []), refused };
  for (const it of entries) {
    const entry = it.webkitGetAsEntry?.();
    const file = it.getAsFile();
    if (entry?.isDirectory) refused.push(`${shortName(entry.name)} is a folder: open it and drop the files inside instead.`);
    else if (file) files.push(file);
  }
  return { files, refused };
}

// ---- pieces of a card ----------------------------------------------------------------------
// A badge centred in the thumbnail's 16:9 box.
const placeholder = (text, kind = 'accent') => h('div.thumb.icon', badge(text, kind));

function thumbOf(item, ready) {
  if (item.kind === 'image' && ready && item.url) {
    // A logo whole, not cropped.
    const img = h('img.thumb.contain', { src: item.url, alt: '', loading: 'lazy', decoding: 'async', draggable: 'false' });
    img.addEventListener('error', () => img.replaceWith(placeholder('No preview')), { once: true });
    return img;
  }
  if (item.status === 'processing') return placeholder('Converting…', 'warn');
  if (item.status === 'failed') return placeholder('Not available', 'danger');
  return placeholder({ image: 'Image', video: 'Video', audio: 'Audio', font: 'Font' }[item.kind] || 'File');
}

function typeOf(item) {
  const ext = /\.([a-z0-9]+)$/i.exec(item.name || '')?.[1]?.toUpperCase();
  const word = WORD[item.kind] || 'file';
  return ext ? `${ext} ${word}` : word[0].toUpperCase() + word.slice(1);
}

// The server's note on a video kept as uploaded, without the rule number.
const plainNote = (note) => String(note).replace(/\s*\(H\d+\)/g, '');

// Copy URL: the /media/… path, which overlay settings take. Where the browser won't copy (plain
// HTTP on the LAN is not a secure context), the URL is shown to select and copy by hand.
async function copyUrl(url, name) {
  if (await copy(url, `Copied the URL of ${shortName(name)}. Paste it into an overlay's settings.`)) return;
  const field = h('input', { type: 'text', readonly: true, value: url, 'aria-label': `URL of ${name}`, onfocus: (e) => e.target.select() });
  const shown = dialog({
    title: 'The file\'s URL',
    body: [h('p', 'Select it and copy it, then paste it into an overlay\'s settings.'), field],
    actions: [{ label: 'Done', value: true, kind: 'primary' }],
  });
  field.focus();
  await shown;
}

// ---- the page ------------------------------------------------------------------------------
export async function list(view, ctx) {
  ctx.setTitle('Media');
  const canWrite = ctx.can('media:write');
  const asked = ctx.query.get('kind');
  if (KINDS.some((k) => k.id === asked)) filter = asked;

  let items = await api.all('/api/v1/media');

  // Upload: a file input behind a button (a styled control, and the same on every browser).
  const input = h('input.sr-only', {
    type: 'file', multiple: true, accept: ACCEPT, tabindex: '-1', 'aria-hidden': 'true',
    onchange: () => {
      const files = Array.from(input.files || []);
      input.value = ''; // the same file can be chosen again
      enqueue(files);
    },
  });
  const chooseButton = (cls) => h('button', { type: 'button', class: cls, dataset: { choose: '' }, onclick: () => input.click() }, 'Choose files');
  const statusEl = h('div', { 'aria-live': 'polite' });
  const failEl = h('div');
  const ffmpegEl = h('div');
  const uploadPart = canWrite
    ? h('section.card', { 'aria-labelledby': 'media-upload' },
      h('div.card-head', h('h2#media-upload', 'Upload'), h('div.actions', chooseButton('btn primary'))),
      h('p', `Images, video, audio and fonts, up to ${bytes(MAX_BYTES)} each.`, isPhone() ? '' : ' You can also drop files anywhere on this page.'),
      ffmpegEl, statusEl, failEl, input)
    : h('p.muted', 'You can see what has been uploaded here. Uploading and deleting files needs an admin.');

  const showFfmpeg = () => {
    if (hasFfmpeg === undefined) mount(ffmpegEl);
    else if (hasFfmpeg) mount(ffmpegEl, h('p.small.muted', 'Phone videos (.MOV, HEVC) are converted automatically so they play in OBS.'));
    else mount(ffmpegEl, notice('Phone videos (.MOV, HEVC) won\'t play in OBS until ffmpeg is installed where this platform runs. Until then, upload MP4 (H.264) or WebM clips.', 'warn'));
  };
  if (canWrite) {
    showFfmpeg();
    api.get('/api/v1/system/info').then((info) => {
      const known = info?.capabilities?.ffmpeg;
      if (typeof known === 'boolean') hasFfmpeg = known;
      showFfmpeg();
    }, () => { /* the line is only advice: left out */ });
  }

  const showUploads = () => {
    const busy = Boolean(uploads.current);
    for (const b of view.querySelectorAll('[data-choose]')) {
      b.disabled = busy;
      b.classList.toggle('busy', busy);
      if (busy) b.setAttribute('aria-busy', 'true');
      else b.removeAttribute('aria-busy');
    }
    const f = uploads.current;
    mount(statusEl, f ? [
      h('p', h('strong', `Uploading ${shortName(f.name)}`), ` (${bytes(f.size)}${uploads.total > 1 ? `, ${uploads.done + 1} of ${uploads.total}` : ''})…`),
      h('p.small.muted', looksLikeVideo(f) && hasFfmpeg
        ? 'A video is converted for OBS once it arrives, which can take a few minutes. Keep this tab open until it\'s done; other sections work meanwhile.'
        : 'Keep this tab open until it\'s done; other sections work meanwhile.'),
    ] : null);
    // What didn't go up stays until the next batch (a toast is gone in seconds), or until cleared.
    mount(failEl, uploads.failures.map((text) => h('div.notice.danger', text)),
      uploads.failures.length && !busy ? h('div.row', h('button.btn.ghost', { type: 'button', onclick: () => { uploads.failures = []; showUploads(); } }, 'Clear these messages')) : null);
  };

  // The list.
  const filtersEl = h('div.row', { role: 'group', 'aria-label': 'Show files of a kind' });
  const summaryEl = h('p.muted.small');
  const listEl = h('div');
  const filesPart = h('section.stack', { 'aria-labelledby': 'media-files' },
    h('div.spread', h('div', h('h2#media-files', 'Files'), summaryEl), filtersEl), listEl);

  const remove = async (item, more) => {
    const name = String(item.name || 'this file');
    const yes = await confirm({ title: `Delete ${shortName(name)}?`, consequence: 'Overlays using this file will show nothing in its place.', confirmLabel: 'Delete' });
    if (!yes) return;
    let deleted = false;
    let failed;
    await run(more?.querySelector('summary'), async () => {
      await api.del(`/api/v1/media/${api.seg(item.id)}`);
      deleted = true;
    }, {
      done: `Deleted ${shortName(name)}`,
      onError: (err) => {
        failed = err;
        // 409: the overlays that use it, by name (the server's detail).
        toast(err?.status === 404 ? `${shortName(name)} was already deleted.` : err);
      },
    });
    if (deleted || failed?.status === 404) {
      items = items.filter((m) => m.id !== item.id);
      renderList();
    } else if (failed?.status === 409) {
      refresh({ force: true }).catch(() => {});
    }
  };

  const card = (item) => {
    const name = String(item.name || 'file');
    const ready = !item.status || item.status === 'ready';
    const users = Array.isArray(item.usedBy) ? item.usedBy : [];
    const actions = [
      ready && item.url ? { label: 'Open in a new tab', onSelect: () => window.open(item.url, '_blank', 'noopener') } : null,
      canWrite ? { label: 'Delete…', danger: true, onSelect: () => remove(item, more) } : null,
    ].filter(Boolean);
    const more = actions.length ? menu('⋯', actions, { buttonClass: 'btn ghost', ariaLabel: `More for ${name}` }) : null;
    const original = item.converted && item.original?.name && item.original.name !== name ? item.original.name : undefined;
    const when = Number.isFinite(Date.parse(item.createdAt)) ? item.createdAt : undefined;
    return h('article.card.stack',
      thumbOf(item, ready),
      h('div.card-head', h('h3.truncate', { title: name }, name), more ? h('div.actions', more) : null),
      h('div',
        h('p.muted.small',
          typeOf(item),
          Number.isFinite(item.size) ? ` · ${bytes(item.size)}` : '',
          when ? [' · ', h('time', { datetime: when, title: new Date(when).toLocaleString() }, `uploaded ${ago(when)}`)] : ''),
        original ? h('p.muted.small.truncate', { title: original }, `${item.kind === 'image' ? 'Converted to JPEG' : 'Converted for OBS'} from ${original}`) : null,
        users.length ? h('p.small', 'Used by ', users.map((slug, i) => [i ? ', ' : '', h('a', { href: `#/overlays/${api.seg(slug)}` }, slug)])) : null),
      item.status === 'processing' ? h('p.small.muted', 'Still being converted for OBS. It can be used once that\'s done.') : null,
      item.status === 'failed' ? h('div.notice.danger', item.error || 'This upload didn\'t finish. Delete it and upload the file again.') : null,
      item.note ? h('div.notice.warn', plainNote(item.note)) : null,
      ready && item.url ? h('div.row', h('button.btn', { type: 'button', 'aria-label': `Copy URL of ${name}`, onclick: () => copyUrl(item.url, name) }, 'Copy URL')) : null);
  };

  function renderList() {
    const count = { all: items.length };
    let total = 0;
    for (const m of items) {
      count[m.kind] = (count[m.kind] || 0) + 1;
      if (Number.isFinite(m.size)) total += m.size;
    }
    const kinds = KINDS.filter((k) => !k.onlyWhenAny || count[k.id]);
    if (!kinds.some((k) => k.id === filter)) filter = 'all';
    const focused = filtersEl.contains(document.activeElement) ? document.activeElement.dataset.kind : undefined;
    mount(filtersEl, items.length ? kinds.map((k) => h('button.btn.small', {
      type: 'button', dataset: { kind: k.id }, 'aria-pressed': String(filter === k.id),
      onclick: () => { filter = k.id; renderList(); },
    }, `${k.label} (${count[k.id] || 0})`)) : null);
    if (focused) filtersEl.querySelector(`[data-kind="${focused}"]`)?.focus();
    summaryEl.hidden = !items.length;
    mount(summaryEl, items.length ? `${items.length} ${items.length === 1 ? 'file' : 'files'}, ${bytes(total)} in all` : null);

    const shown = filter === 'all' ? items : items.filter((m) => m.kind === filter);
    if (!items.length) {
      // The upload card above holds the button.
      mount(listEl, empty('No media yet',
        canWrite ? 'Upload logos, clips, sounds and fonts above, then pick them in overlay settings and the lineup.' : 'Nothing has been uploaded yet.'));
    } else if (!shown.length) {
      const k = KINDS.find((x) => x.id === filter);
      mount(listEl, empty(k?.none || 'Nothing here', 'Nothing uploaded is of this kind.',
        h('button.btn', { type: 'button', onclick: () => { filter = 'all'; renderList(); } }, 'Show all')));
    } else {
      mount(listEl, h('div.grid', shown.map(card)));
    }
  }

  // Someone else's upload or delete, an overlay starting or stopping to use a file: picked up
  // every 15 s. Never under an open menu or dialog, nor mid-upload (its end reloads).
  const sig = (list) => list.map((m) => `${m.id}.${m.rev}.${m.status}.${(m.usedBy || []).join('|')}`).join(',');
  async function refresh({ force } = {}) {
    for (const t of listEl.querySelectorAll('time[datetime]')) t.textContent = `uploaded ${ago(t.getAttribute('datetime'))}`;
    if (uploads.current && !force) return;
    const next = await api.all('/api/v1/media');
    if (sig(next) === sig(items)) return;
    if (!force && (listEl.querySelector('details[open]') || document.querySelector('dialog[open]'))) return;
    items = next;
    renderList();
  }
  let ticks = 0;
  const stop = every(15000, () => (ticks++ ? refresh() : undefined));

  const onUploads = (event) => {
    if (event.type === 'added' && event.item?.id && !items.some((m) => m.id === event.item.id)) {
      items = [event.item, ...items];
      if (filter !== 'all' && filter !== event.item.kind) filter = 'all';
      renderList();
    }
    showUploads();
    if (event.type === 'finished') {
      refresh().catch(() => {});
      // A file whose answer was lost may land a moment later.
      clearTimeout(later);
      if (uploads.failures.length) later = setTimeout(() => refresh().catch(() => {}), 4000);
    }
  };
  let later;
  uploads.listeners.add(onUploads);

  // Drop files anywhere on the page (desktop). A drag that started on the page (a thumbnail, a
  // link) is not an upload.
  let dragTimer;
  let fromPage = false;
  const setDropping = (on) => view.classList.toggle('dropping', on); // .main.dropping
  const hasFiles = (e) => !fromPage && Array.from(e.dataTransfer?.types || []).includes('Files');
  const onDragOver = (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDropping(true);
    clearTimeout(dragTimer);
    dragTimer = setTimeout(() => setDropping(false), 300);
  };
  const onDrop = (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); // or the browser opens the file in place of the app
    clearTimeout(dragTimer);
    setDropping(false);
    const { files, refused } = droppedFiles(e.dataTransfer);
    enqueue(files, refused);
  };
  const drag = canWrite ? [
    ['dragstart', () => { fromPage = true; }],
    ['dragend', () => { fromPage = false; }],
    ['dragenter', onDragOver],
    ['dragover', onDragOver],
    ['drop', onDrop],
  ] : [];
  for (const [type, fn] of drag) document.addEventListener(type, fn);

  // A long file name breaks rather than pushing the page sideways on a phone (.main wraps words).
  mount(view, pageHead('Media'), h('div.stack', uploadPart, filesPart));
  renderList();
  showUploads(); // an upload started before leaving Media and coming back

  return () => {
    stop();
    uploads.listeners.delete(onUploads);
    clearTimeout(later);
    clearTimeout(dragTimer);
    setDropping(false);
    for (const [type, fn] of drag) document.removeEventListener(type, fn);
  };
}
