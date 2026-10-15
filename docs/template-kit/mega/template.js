// Mega Show: a reference template that uses every part of the runtime SDK (SK, 04 §4.4). Read it
// with docs/template-kit/TEMPLATE-GUIDE.md. Rules it follows throughout:
// - data comes only from SK (state, events, chat, alerts); the template never fetches anything;
// - an absent value hides its element (never "0", never "undefined": H6);
// - timing uses SK.clock (server time) and timers, never requestAnimationFrame (H9);
// - DOM text is set with textContent, never innerHTML with data in it.
(() => {
  // ---- small helpers ---------------------------------------------------------------------------
  const $ = (root, sel) => (root ? root.querySelector(sel) : null);
  const $$ = (root, sel) => (root ? [...root.querySelectorAll(sel)] : []);
  const pad = (n) => String(n).padStart(2, '0');
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  // "HH:MM:SS" or "MM:SS" for a duration in ms.
  function clock(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600);
    return h ? `${h}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}` : `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
  }
  // A lineup time (HH:MM, the show's local time) as the settings ask for it.
  function showTime(hhmm) {
    if (typeof hhmm !== 'string' || !/^\d\d:\d\d$/.test(hhmm)) return '';
    if ((S().timetable || {}).clock === '24h') return hhmm;
    const [h, m] = hhmm.split(':').map(Number);
    return `${((h + 11) % 12) + 1}:${pad(m)} ${h < 12 ? 'AM' : 'PM'}`;
  }

  // ---- settings (04 §4.3) ----------------------------------------------------------------------
  // SK.settings: the resolved values (saved, else bound state, else the default). It changes while
  // the operator edits: SK.onSettings tells us.
  const S = () => SK.settings || {};
  function applySettings() {
    const s = S();
    const root = document.documentElement;
    const accent = /^#[0-9a-f]{6}$/i.test(s.accent || '') ? s.accent : '#16e0ff';
    root.style.setProperty('--accent', accent);
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(accent.slice(i, i + 2), 16));
    root.style.setProperty('--accent-glow', `rgba(${r}, ${g}, ${b}, .45)`);
    root.setAttribute('data-theme', s.theme === 'day' ? 'day' : 'night');
    root.toggleAttribute('data-no-grain', s.grain === false);
    root.style.setProperty('--chat-x', `${Number(s.chatX) || 0}px`);
    root.style.setProperty('--chat-y', `${Number(s.chatY) || 0}px`);
    fill(currentRoot);
  }

  // A file shipped in this package, at its versioned, cacheable URL.
  document.documentElement.style.setProperty('--grain', `url("${SK.asset('assets/grain.svg')}")`);

  // ---- scenes (04 §4.7, 05 §5.4) ---------------------------------------------------------------
  // The declarative scenes come from <template data-skp-scene> in index.html. "auto" is built here:
  // the Starting Soon card until go-live, then the live scene, switching by itself at go-live.
  let currentRoot = null;
  let cancelAuto = null;
  function cloneScene(id) {
    const t = document.querySelector(`template[data-skp-scene="${id}"]`);
    const frag = document.createDocumentFragment();
    if (t) frag.append(t.content.cloneNode(true));
    return frag;
  }
  function autoScene() {
    const at = SK.state('show.goLiveAt');
    const before = typeof at === 'number' && SK.clock.now() < at;
    if (cancelAuto) cancelAuto();
    // SK.clock.at runs on server time and survives throttled timers; it returns a cancel function.
    cancelAuto = before ? SK.clock.at(at, () => {
      cancelAuto = null;
      // Defining it again while it's on screen rebuilds it in place: now the live scene.
      if (SK.scene === 'auto') SK.defineScene('auto', autoScene);
    }) : null;
    return cloneScene(before ? 'starting' : 'program');
  }
  SK.defineScene('auto', autoScene);

  // Every scene change: (id, previous id, transition, the new root element).
  SK.onScene((id, prev, transition, root) => {
    currentRoot = root || null;
    fill(currentRoot);
    showActive();
  });

  // ---- filling a scene from settings and state ------------------------------------------------
  function fill(root) {
    if (!root) return;
    const s = S();
    for (const node of $$(root, '[data-text]')) node.textContent = s[node.getAttribute('data-text')] || '';
    for (const img of $$(root, '[data-logo]')) {
      img.hidden = !s.logo;
      if (s.logo && img.getAttribute('src') !== s.logo) {
        img.src = s.logo; // an uploaded image: /media/<id>/<name>
        img.onerror = () => { img.hidden = true; SK.log.warn('the logo could not be loaded', { logo: s.logo }); };
      }
    }
    for (const v of $$(root, '[data-bg-video]')) {
      v.hidden = SK.env.lite || !s.background; // no video in lite previews (phones)
      if (!v.hidden && v.getAttribute('src') !== s.background) {
        v.src = s.background;
        v.play().catch(() => {});
      }
    }
    const date = $(root, '[data-date]');
    if (date) date.textContent = s.date ? new Date(`${s.date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' }).toUpperCase() : '';
    const head = $(root, '[data-headliner]');
    if (head) {
      head.hidden = !s.headliner;
      $(head, 'b').textContent = s.headliner || '';
    }
    const shout = $(root, '[data-shoutout]');
    if (shout) shout.textContent = s.headliner || 'HEADLINER';
    for (const t of $$(root, '[data-ticker]')) {
      const items = Array.isArray(s.tickerItems) ? s.tickerItems.filter(Boolean) : [];
      t.hidden = !s.ticker || !items.length;
      const run = $(t, '.run');
      run.replaceChildren(...items.concat(items).map((i) => el('span', '', i)));
    }
    fillLineup(root);
    fillLive(root);
  }

  // The lineup (show.lineup: [{ time, name, b2b?, headliner?, closer?, logo?, startAt }]) and who
  // is on (show.currentSlot). Headliner and closer are different flags (H8).
  function fillLineup(root) {
    const list = $(root, '[data-acts]');
    const slots = SK.state('show.lineup');
    const on = SK.state('show.currentSlot');
    if (list) {
      const showTimes = (S().timetable || {}).showTimes !== false;
      list.replaceChildren(...(Array.isArray(slots) ? slots : []).map((slot, i) => {
        const li = el('li', i === on ? 'on' : '');
        if (showTimes) li.append(el('span', 't', showTime(slot.time)));
        li.append(el('span', 'n', slot.b2b ? `${slot.name} b2b ${slot.b2b}` : slot.name));
        if (slot.headliner) li.append(el('span', 'tag', 'HEADLINER'));
        if (slot.closer) li.append(el('span', 'tag', 'CLOSING'));
        return li;
      }));
    }
    const onNow = $(root, '[data-onnow]');
    if (onNow) {
      const slot = Array.isArray(slots) && Number.isInteger(on) ? slots[on] : undefined;
      onNow.hidden = !slot;
      if (slot) $(onNow, 'b').textContent = slot.b2b ? `${slot.name} b2b ${slot.b2b}` : slot.name;
    }
  }

  // The live scene's corner: viewers (absent → hidden; viewers.stale → quieter), REC.
  function fillLive(root) {
    const s = S();
    const viewers = $(root, '[data-viewers]');
    if (viewers) {
      const v = SK.state('viewers.total');
      viewers.hidden = s.showViewers === false || typeof v !== 'number';
      if (typeof v === 'number') $(viewers, 'b').textContent = v.toLocaleString('en-US');
      viewers.classList.toggle('stale', SK.state('viewers.stale') === true);
    }
    const chat = $(root, '[data-chat]');
    if (chat) chat.hidden = s.chat === false;
    tick();
  }

  // State changes: one listener for every show.* key ((key, value, prev)), and single keys.
  SK.onState('show.*', () => fill(currentRoot));
  SK.onState('viewers.total', () => fillLive(currentRoot));
  SK.onState('viewers.stale', () => fillLive(currentRoot));

  // ---- clocks: the countdown, REC, now playing's progress -------------------------------------
  // A 250 ms timer is enough and keeps working in OBS; SK.clock.now() is server time.
  function tick() {
    const root = currentRoot;
    if (!root) return;
    const now = SK.clock.now();
    const count = $(root, '[data-countdown]');
    if (count) {
      const at = SK.state('show.goLiveAt');
      count.hidden = typeof at !== 'number' || at <= now;
      if (!count.hidden) $(count, 'b').textContent = clock(at - now);
    }
    const rec = $(root, '[data-rec]');
    if (rec) {
      const since = SK.state('show.recStartedAt');
      rec.hidden = S().showRec === false || typeof since !== 'number';
      if (!rec.hidden) $(rec, 'b').textContent = clock(now - since);
    }
    const np = $(root, '[data-np]');
    if (np) {
      const t = SK.music.track(); // { title, artists, album, art, durationMs, progressMs, … } or undefined
      np.hidden = !t;
      if (t) {
        $(np, '[data-np-title]').textContent = t.title || '';
        $(np, '[data-np-artist]').textContent = Array.isArray(t.artists) ? t.artists.join(', ') : '';
        const art = $(np, '[data-np-art]');
        art.hidden = !t.art;
        if (t.art && art.getAttribute('src') !== t.art) art.src = t.art; // an https image from the service
        const p = SK.music.progress(); // interpolated locally between updates: never poll
        $(np, '[data-np-bar]').style.width = t.durationMs && typeof p === 'number' ? `${Math.min(100, (p / t.durationMs) * 100)}%` : '0';
      }
    }
  }
  setInterval(tick, 250);

  // ---- actions (04 §4.6): { args, startAt, durationMs, lateMs } ---------------------------------
  // The runtime calls the handler at startAt (server time) on every source, so the horizontal and
  // vertical feeds show it on the same frame. Show it for its window; skip it if not on the live
  // scene, but bring it back if the live scene returns while the window is still open.
  const active = new Map(); // action id → { t, make }
  function present(id, t, make) {
    active.set(id, { t, make });
    showActive();
  }
  function showActive() {
    const box = $(currentRoot, '[data-actions]');
    if (!box) return;
    for (const [id, { t, make }] of active) {
      const end = t.startAt + t.durationMs;
      if (SK.clock.now() >= end) { active.delete(id); continue; }
      if ($(box, `[data-action="${id}"]`)) continue;
      const card = make(t.args || {});
      card.setAttribute('data-action', id);
      box.append(card);
      SK.mount(card); // data-skp-state="enter" → "idle"; CSS animates
      // Leave so the exit animation ends with the window (the exit lasts .45 s in the CSS).
      SK.clock.at(Math.max(SK.clock.now(), end - 450), () => { SK.unmount(card); active.delete(id); });
    }
  }
  function card(kicker, big) {
    const c = el('div', 'card');
    c.append(el('span', 'k', kicker), el('b', '', big));
    return c;
  }
  SK.action('titleCard', (t) => present('titleCard', t, (args) => {
    const slots = SK.state('show.lineup');
    const on = SK.state('show.currentSlot');
    const name = args.name || (Array.isArray(slots) && slots[on] ? slots[on].name : '');
    return card('ON THE DECKS', name || S().title || '');
  }));
  SK.action('nowPlaying', (t) => present('nowPlaying', t, (args) => {
    const track = SK.music.track();
    return card('NOW PLAYING', args.title || (track ? track.title : '') || 'ID?');
  }));
  SK.action('announce', (t) => present('announce', t, (args) => card('ANNOUNCEMENT', args.text || S().tagline || '')));

  // ---- alerts (05 §5.5): the server queues them; this only fills the element ------------------
  SK.alerts.render((alert, box) => {
    box.className = 'alert';
    const a = alert.amount || {};
    const amount = a.unit === 'currency'
      ? (() => { try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: a.currency }).format(Number(a.value)); } catch { return `${a.value} ${a.currency}`; } })()
      : Number.isInteger(a.value) ? `${a.value.toLocaleString('en-US')} ${a.unit}` : '';
    box.append(el('span', 'k', String(alert.kind || 'alert').toUpperCase()), el('b', '', alert.user && !alert.user.anonymous ? alert.user.name : 'Anonymous'));
    if (amount) box.append(el('span', '', amount));
  });

  // ---- chat (02 §2.3, 05 §5.6): return an element; the runtime mounts it, keeps chat.max on
  // screen, and removes deleted messages and banned users' messages by itself ----------------
  const chatShown = [];
  SK.chat.onAdd((m) => {
    if (S().chat === false || !m || typeof m !== 'object') return undefined;
    const msg = el('div', 'msg');
    if (typeof m.user?.color === 'string' && /^#[0-9a-f]{6}$/i.test(m.user.color)) msg.style.setProperty('--name', m.user.color);
    msg.append(el('b', '', m.user?.name || 'someone'));
    for (const f of Array.isArray(m.fragments) && m.fragments.length ? m.fragments : [{ type: 'text', text: m.text || '' }]) {
      if (f.type === 'emote' && typeof f.image === 'string' && f.image.startsWith('https://')) {
        const img = el('img');
        img.src = f.image;
        img.alt = f.text || '';
        msg.append(img);
      } else msg.append(document.createTextNode(f.text || ''));
    }
    // At most chatLines on screen (the runtime's own cap is chat.max): the oldest leave first.
    const still = chatShown.filter((e) => e.isConnected);
    chatShown.length = 0;
    chatShown.push(...still, msg);
    while (chatShown.length > (Number(S().chatLines) || 6)) SK.unmount(chatShown.shift());
    return msg;
  });

  // ---- start -----------------------------------------------------------------------------------
  // SK.ready: the snapshot is in and settings are resolved; state handlers have fired once.
  SK.ready(() => {
    applySettings();
    // Preload the logo so its first reveal doesn't stutter (05 §5.8).
    if (S().logo) SK.preload(S().logo);
  });
  SK.onSettings(applySettings);
})();
