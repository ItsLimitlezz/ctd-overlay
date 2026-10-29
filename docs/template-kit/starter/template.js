// Starter: a small template to copy for a new overlay. Read it with TEMPLATE-GUIDE.md; mega/ shows
// every other feature (more scenes, auto, chat, alerts, music, a ticker). Rules it follows:
// - data comes only from SK (settings, state, actions); the template never fetches anything;
// - an absent value hides its element (never "0", never "undefined");
// - timing uses SK.clock (server time) and timers, never requestAnimationFrame;
// - text is set with textContent, never innerHTML with data in it.
(() => {
  const $ = (root, sel) => (root ? root.querySelector(sel) : null);
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  // ---- settings: SK.settings is resolved (saved, else bound state, else the default) ----------
  const S = () => SK.settings || {};
  function applySettings() {
    const s = S();
    const accent = /^#[0-9a-f]{6}$/i.test(s.accent || '') ? s.accent : '#16e0ff';
    document.documentElement.style.setProperty('--accent', accent);
    fill();
  }

  // ---- the scene: filled when it mounts, and again when settings or state change ---------------
  let root = null;
  SK.onScene((id, prev, transition, sceneRoot) => {
    root = sceneRoot || null;
    fill();
    showCard();
  });

  // Who's on: show.currentSlot is an index into show.lineup ([{ time, name, b2b?, … }]).
  function actOn() {
    const slots = SK.state('show.lineup');
    const on = SK.state('show.currentSlot');
    const slot = Array.isArray(slots) && Number.isInteger(on) ? slots[on] : undefined;
    if (!slot || !slot.name) return '';
    return slot.b2b ? `${slot.name} b2b ${slot.b2b}` : slot.name;
  }

  function fill() {
    if (!root) return;
    const s = S();
    const bug = $(root, '[data-bug]');
    bug.setAttribute('data-corner', ['tl', 'tr', 'bl', 'br'].includes(s.corner) ? s.corner : 'tl');
    $(root, '[data-title]').textContent = s.title || '';

    const onNow = $(root, '[data-onnow]');
    const name = actOn();
    onNow.hidden = s.showOnNow === false || !name;
    $(onNow, 'b').textContent = name;

    // Absent is not 0: no count, no chip.
    const viewers = $(root, '[data-viewers]');
    const v = SK.state('viewers.total');
    viewers.hidden = s.showViewers === false || typeof v !== 'number';
    if (typeof v === 'number') $(viewers, 'b').textContent = v.toLocaleString('en-US');
    viewers.classList.toggle('stale', SK.state('viewers.stale') === true);
  }

  SK.onState('show.lineup', fill);
  SK.onState('show.currentSlot', fill);
  SK.onState('viewers.total', fill);
  SK.onState('viewers.stale', fill);

  // ---- the title card action: { args, startAt, durationMs, lateMs } ----------------------------
  // The runtime calls it at startAt on server time, on every source at once (16:9 and 9:16 on the
  // same frame). It stays for its window; if the scene is rebuilt meanwhile it comes back.
  let card = null; // { t, el }
  SK.action('card', (t) => {
    if (card && card.el) SK.unmount(card.el);
    card = { t, el: null };
    showCard();
  });
  function showCard() {
    const box = $(root, '[data-cards]');
    if (!box || !card) return;
    const end = card.t.startAt + card.t.durationMs;
    if (SK.clock.now() >= end) { card = null; return; }
    if (card.el && card.el.isConnected) return;
    const args = card.t.args || {};
    const c = el('div', 'card');
    c.append(el('span', 'k', args.kicker || 'ON NOW'), el('b', '', args.text || actOn() || S().title || ''));
    box.append(c);
    SK.mount(c); // data-skp-state="enter" → "idle"; the CSS animates
    card.el = c;
    const mine = card;
    // Leave so the exit (.45 s in the CSS) ends with the window.
    SK.clock.at(Math.max(SK.clock.now(), end - 450), () => {
      SK.unmount(c);
      if (card === mine) card = null;
    });
  }

  // ---- start: the snapshot is in and settings are resolved ------------------------------------
  SK.ready(applySettings);
  SK.onSettings(applySettings);
})();
