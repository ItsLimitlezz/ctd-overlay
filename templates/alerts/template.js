// D/PRTMNT alerts (02 §2.4, 05 §5.5). The platform queues alerts and gives each its window on
// screen; the runtime creates the element, mounts it and takes it off. This file fills it in:
// what happened, who, how much, their message, and plays the sound if one is set.
(() => {
  const PLATFORMS = {
    twitch: ['TWITCH', '#9146ff'], youtube: ['YOUTUBE', '#ff0033'], kick: ['KICK', '#53fc18'],
    facebook: ['FACEBOOK', '#1877f2'], instagram: ['INSTAGRAM', '#e1306c'], tiktok: ['TIKTOK', '#25f4ee'], x: ['X', '#ffffff'],
  };
  const TITLES = {
    follow: 'NEW FOLLOWER', subscription: 'NEW SUB', gift: 'GIFTED SUBS', cheer: 'CHEER', kicks: 'KICKS',
    raid: 'RAID', membership: 'NEW MEMBER', superchat: 'SUPER CHAT', tip: 'TIP',
  };
  let s = {};

  const plural = (n, one, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
  // Money is a decimal string with its currency (02 §2.4), formatted by the currency's own rules.
  function money(a) {
    const n = Number(a.value);
    if (!Number.isFinite(n)) return String(a.value);
    try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: a.currency }).format(n); } catch { return `${a.value} ${a.currency || ''}`.trim(); }
  }
  // The line under the name: how much, in plain words.
  function what(alert) {
    const a = alert.amount || {};
    const v = Number.isInteger(a.value) ? a.value : undefined;
    switch (alert.kind) {
      case 'subscription': {
        // Twitch writes tiers 1000/2000/3000 (or Prime), others 1/2/3.
        const tier = alert.tier === 'Prime' ? 'Prime' : /^[123](000)?$/.test(String(alert.tier || '')) ? `Tier ${String(alert.tier)[0]}` : '';
        const months = v && v > 1 ? `${plural(v, 'month')}` : 'subscribed';
        return [months, tier].filter(Boolean).join(' · ');
      }
      case 'gift': return v ? `gifted ${plural(v, 'sub')}` : 'gifted a sub';
      case 'cheer': return v ? `cheered ${plural(v, 'bit')}` : 'cheered';
      case 'kicks': return v ? `sent ${plural(v, 'kick')}` : 'sent kicks';
      case 'raid': return v ? `raiding with ${plural(v, 'viewer')}` : 'is raiding';
      case 'membership': return v && v > 1 ? `member for ${plural(v, 'month')}` : 'became a member';
      case 'superchat':
      case 'tip': return a.unit === 'currency' ? money(a) : '';
      case 'follow': return 'followed';
      default: return '';
    }
  }
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function sound() {
    if (typeof s.sound !== 'string' || !s.sound) return;
    try {
      const audio = new Audio(s.sound);
      const volume = Number.isFinite(Number(s.volume)) ? Number(s.volume) : 70;
      audio.volume = Math.max(0, Math.min(1, volume / 100));
      audio.play().catch(() => { /* a preview without a click may not play sound; OBS does */ });
    } catch { /* no sound is better than no alert */ }
  }

  SK.alerts.render((alert, box) => {
    const kind = typeof alert.kind === 'string' ? alert.kind : 'alert';
    box.className = `alert ${kind}`;
    const eyebrow = el('div', 'eyebrow');
    const p = PLATFORMS[alert.platform];
    if (s.platformTags !== false && p) {
      const tag = el('span', 'plat', p[0]);
      tag.style.setProperty('--plat', p[1]);
      eyebrow.append(tag);
    }
    eyebrow.append(el('span', '', TITLES[kind] || kind.toUpperCase()));
    box.append(eyebrow, el('div', 'who', alert.user?.anonymous ? 'Anonymous' : alert.user?.name || 'Someone'));
    const line = what(alert);
    if (line) box.append(el('div', 'what', line));
    const text = alert.message && typeof alert.message.text === 'string' ? alert.message.text.trim() : '';
    if (s.showMessage !== false && text) box.append(el('div', 'message', text.length > 200 ? `${text.slice(0, 197)}…` : text));
    sound();
  });

  function applySettings() {
    s = SK.settings || {};
    document.documentElement.style.setProperty('--accent', typeof s.accent === 'string' ? s.accent : '#16e0ff');
    for (const box of document.querySelectorAll('.alerts')) {
      box.classList.toggle('center', s.position === 'center');
      box.classList.toggle('bottom', s.position === 'bottom');
    }
  }
  SK.ready(applySettings);
  SK.onSettings(applySettings);
  SK.onScene(applySettings);
  applySettings();
})();
