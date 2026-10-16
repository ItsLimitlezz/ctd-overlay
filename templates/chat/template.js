// D/PRTMNT chat (02 §2.3, 05 §5.6). The runtime brings the merged chat of every connected
// platform, paces it, keeps at most chat.max on screen and takes deleted messages and banned users
// off at once. This file builds one message's element and applies the settings: what to hide, how
// many stay, and for how long.
(() => {
  // A platform's tag and colour; anything else shows no tag.
  const PLATFORMS = {
    twitch: ['TWITCH', '#9146ff'], youtube: ['YOUTUBE', '#ff0033'], kick: ['KICK', '#53fc18'],
    facebook: ['FACEBOOK', '#1877f2'], instagram: ['INSTAGRAM', '#e1306c'], tiktok: ['TIKTOK', '#25f4ee'], x: ['X', '#ffffff'],
  };
  // Marks, in this order; at most two on one message.
  const ROLES = [['broadcaster', 'HOST', 'host'], ['moderator', 'MOD'], ['vip', 'VIP'], ['founder', 'FOUNDER'], ['subscriber', 'SUB'], ['member', 'MEMBER']];
  const shown = []; // [{ el, timer }], oldest first: the setting "lines" under the runtime's chat.max
  let s = {};

  // The platform a message came from: the field a connector may add, else its user id's prefix.
  const platformOf = (m) => (typeof m.platform === 'string' ? m.platform : typeof m.user?.id === 'string' ? m.user.id.split(':')[0] : '');

  // A name colour that reads on the dark panel: a very dark one is lifted toward white.
  function readable(hex) {
    if (typeof hex !== 'string' || !/^#[0-9a-f]{6}$/i.test(hex)) return null;
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    if (lum >= 0.35) return hex;
    const mix = (c) => Math.round(c + (255 - c) * (0.35 - lum) * 1.6).toString(16).padStart(2, '0');
    return `#${mix(r)}${mix(g)}${mix(b)}`;
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  // The message text: its fragments (emotes as images from the platform), else the plain text.
  function textOf(m) {
    const span = el('span', 'text');
    const frags = Array.isArray(m.fragments) && m.fragments.length ? m.fragments : [{ type: 'text', text: String(m.text || '') }];
    for (const f of frags) {
      if (f && f.type === 'emote' && typeof f.image === 'string' && /^https:\/\//.test(f.image)) {
        const img = el('img', 'emote');
        img.src = f.image;
        img.alt = typeof f.text === 'string' ? f.text : '';
        img.decoding = 'async';
        img.referrerPolicy = 'no-referrer';
        span.append(img);
      } else {
        span.append(document.createTextNode(f && typeof f.text === 'string' ? f.text : ''));
      }
    }
    return span;
  }

  function build(m) {
    const user = m.user || {};
    const roles = Array.isArray(user.roles) ? user.roles : [];
    const msg = el('div', 'msg');
    if (m.kind === 'event') msg.classList.add('event');
    if (m.join) msg.classList.add('join'); // "dj_fan joined" (Instagram, TikTok): lighter than a comment
    if (m.action) msg.classList.add('action');
    if (m.highlighted) msg.classList.add('highlighted');
    const colour = s.nameColour === 'white' ? '#ffffff' : s.nameColour === 'accent' ? null : readable(user.color);
    if (colour) msg.style.setProperty('--name', colour);

    const head = el('div', 'head');
    const p = PLATFORMS[platformOf(m)];
    if (s.platformTags !== false && p) {
      const tag = el('span', 'plat', p[0]);
      tag.style.setProperty('--plat', p[1]);
      head.append(tag);
    }
    if (s.roleMarks !== false) {
      for (const [, label, cls] of ROLES.filter(([r]) => roles.includes(r)).slice(0, 2)) {
        head.append(el('span', `role${cls ? ` ${cls}` : ''}`, label));
      }
    }
    head.append(el('span', 'name', user.name || user.login || 'someone'));
    msg.append(head, textOf(m));
    return msg;
  }

  // Whether the settings hide a message.
  function hidden(m) {
    const roles = Array.isArray(m.user?.roles) ? m.user.roles : [];
    if (s.hideBots !== false && roles.includes('bot')) return true;
    if (s.hideCommands !== false && /^\s*!/.test(String(m.text || ''))) return true;
    if (s.hideEvents && m.kind === 'event') return true;
    const names = (Array.isArray(s.hidden) ? s.hidden : []).map((n) => String(n).trim().toLowerCase()).filter(Boolean);
    const who = [m.user?.name, m.user?.login].filter((n) => typeof n === 'string').map((n) => n.toLowerCase());
    return who.some((n) => names.includes(n));
  }

  // At most "lines" messages; each leaves after "lifetime" seconds if set.
  function keep(msg, m, initial) {
    for (let i = shown.length - 1; i >= 0; i--) if (!shown[i].el.isConnected && shown[i].placed) shown.splice(i, 1);
    const entry = { el: msg, timer: null, placed: false };
    queueMicrotask(() => { entry.placed = true; });
    shown.push(entry);
    trim();
    const life = Number(s.lifetime) || 0;
    if (life > 0) {
      // A message from the backlog keeps only what is left of its time.
      const age = initial && typeof m.ts === 'number' ? Math.max(0, SK.clock.now() - m.ts) : 0;
      entry.timer = setTimeout(() => SK.unmount(msg), Math.max(0, life * 1000 - age));
    }
  }
  function trim() {
    const max = Math.max(1, Number(s.lines) || 12);
    while (shown.length > max) {
      const old = shown.shift();
      clearTimeout(old.timer);
      SK.unmount(old.el);
    }
  }

  function applySettings() {
    s = SK.settings || {};
    const root = document.documentElement;
    root.style.setProperty('--accent', typeof s.accent === 'string' ? s.accent : '#16e0ff');
    root.style.setProperty('--size', `${Number(s.fontSize) || 26}px`);
    for (const box of document.querySelectorAll('.chat')) box.classList.toggle('panel', s.panel !== false);
    trim();
  }

  SK.chat.onAdd((m, { initial } = {}) => {
    if (!m || typeof m !== 'object' || hidden(m)) return undefined;
    const life = Number(s.lifetime) || 0;
    if (initial && life > 0 && typeof m.ts === 'number' && SK.clock.now() - m.ts > life * 1000) return undefined;
    const msg = build(m);
    keep(msg, m, initial);
    return msg;
  });

  SK.ready(applySettings);
  SK.onSettings(applySettings);
  SK.onScene(applySettings);
  applySettings();
})();
