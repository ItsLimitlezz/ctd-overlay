/* Sample data for ?mock=1 (08 §8.5): what an overlay looks like mid-show, without a server, for the
   admin UI's previews and template authors. Loaded by sk.js in mock mode, through window.__skpMock.
   Feeds: a lineup; a chat stream with every role, emotes, a long name, a deleted message and a
   user's messages cleared; one alert of every kind including a gift burst, in server-style
   display windows; tracks with progress, one of them paused; viewer counts that change, go
   briefly unknown and briefly stale; and each declared action once. Shapes follow the payload
   schemas (docs/standard/schemas), and the chat backlog is trimmed as the server trims it.
   Like sk.js it must run in Chromium 103 and load nothing else. */
(() => {
  'use strict';
  const mock = window.__skpMock;
  if (!mock) return;
  const meta = mock.meta;
  const now = mock.now;
  const MIN = 60000;
  // ?mockSpeed=20 runs the sample show 20x faster (tests and impatient template authors).
  const speed = Math.max(1, Number(new URLSearchParams(location.search).get('mockSpeed')) || 1);
  const every = (ms, fn) => setInterval(fn, ms / speed);
  const later = (ms, fn) => setTimeout(fn, ms / speed);

  // Emotes are inline SVG so previews never reach out to a CDN.
  const emote = (color) => 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28"><circle cx="14" cy="14" r="13" fill="' + color + '"/>' +
    '<circle cx="9" cy="11" r="2.5" fill="#fff"/><circle cx="19" cy="11" r="2.5" fill="#fff"/>' +
    '<path d="M8 17q6 6 12 0" stroke="#fff" stroke-width="2" fill="none"/></svg>');

  const people = [
    { id: 'twitch:1', login: 'dprtmnt', name: 'DPRTMNT', color: '#16E0FF', roles: ['broadcaster'] },
    { id: 'twitch:2', login: 'trapment', name: 'Trapment', color: '#FF0090', roles: ['moderator', 'subscriber'] },
    { id: 'kick:3', login: 'bia', name: 'BIA', color: '#36D67B', roles: ['vip'] },
    { id: 'twitch:4', login: 'francis_zamir', name: 'Francis Zamir', color: '#FFB020', roles: ['subscriber', 'founder'] },
    { id: 'youtube:5', login: 'undercover', name: 'UNDERCOVER', roles: ['member'] }, // YouTube: no colour
    { id: 'twitch:6', login: 'verified_dj', name: 'VerifiedDJ', color: '#B48CFF', roles: ['verified'] },
    { id: 'kick:7', login: 'the_artist', name: 'TheArtist', color: '#F2F0EA', roles: ['artist'] },
    { id: 'twitch:8', login: 'nightbot', name: 'Nightbot', color: '#8A8A8A', roles: ['bot'] },
    { id: 'twitch:9', login: 'averyveryverylongusernamethatkeepsgoing', name: 'AVeryVeryVeryLongUsernameThatKeepsGoing', color: '#FF2A2A', roles: [] },
  ];

  const lines = [
    [{ type: 'text', text: 'that drop ' }, { type: 'emote', text: 'Hype', image: emote('#FF0090'), animated: false }],
    [{ type: 'text', text: 'Toronto in the building' }],
    [{ type: 'text', text: 'ID? ' }, { type: 'emote', text: 'Shazam', image: emote('#16E0FF'), animated: false }, { type: 'text', text: ' anyone' }],
    [{ type: 'mention', text: '@BIA' }, { type: 'text', text: ' b2b when' }],
    [{ type: 'text', text: 'lineup is at ' }, { type: 'link', text: 'https://example.com/lineup' }],
    [{ type: 'emote', text: 'Wave', image: emote('#36D67B'), animated: false }],
    [{ type: 'text', text: 'this is a longer message to check that chat wraps cleanly over several lines without pushing anything off the edge of the frame' }],
  ];

  let n = 0;
  const msg = (person, fragments) => {
    n++;
    const user = Object.assign({ avatar: emote(person.color || '#8A8A8A'), badges: [] }, person);
    if (!person.color) delete user.color;
    return {
      id: 'msg_mock_' + n,
      platformMessageId: 'mock-' + n,
      channel: 'dprtmnt',
      user,
      text: fragments.map((f) => f.text).join(''),
      fragments,
      reply: null,
      highlighted: person.roles.indexOf('broadcaster') >= 0,
      action: false,
    };
  };
  const nextMsg = () => msg(people[n % people.length], lines[n % lines.length]);

  // Slots carry server-resolved instants (09 §9.1); `time` is only a display label.
  const t = now();
  const pad = (n) => String(n).padStart(2, '0');
  const slot = (offsetMin, name, extra) => {
    const startAt = t + offsetMin * MIN;
    const d = new Date(startAt);
    return Object.assign({ time: pad(d.getHours()) + ':' + pad(d.getMinutes()), name, startAt }, extra || {});
  };
  const lineup = [
    slot(-90, 'Manzone & strong'),
    slot(-30, 'Trapment'),
    slot(30, 'BIA', { b2b: 'DOLF' }),
    slot(90, 'VIKKSTAR', { headliner: true }),
    slot(150, 'UNDERCOVER', { closer: true }),
  ];

  const track = (title, artists, durationMs, progressMs) => ({
    title, artists, album: 'Mock Sessions', art: emote('#16E0FF'), url: 'https://example.com/track',
    durationMs, progressMs, progressAt: now(), playing: true, source: 'mock',
  });
  const tracks = [
    track('Strobe', ['deadmau5'], 637000, 120400),
    track('Opus', ['Eric Prydz'], 543000, 30000),
    Object.assign(track('Midnight City', ['M83'], 243000, 61000), { playing: false }),
  ];

  // As many backlog messages as the server would send this template: chat.recent, default 50,
  // 0 to 200 (02 §2.3).
  const chatSpec = (meta.consumes || {}).chat;
  const r = chatSpec && chatSpec.recent;
  const recentCount = !chatSpec ? 0 : r === undefined ? 50 : Number.isInteger(r) ? Math.min(200, Math.max(0, r)) : 0;
  const backlog = [nextMsg(), nextMsg(), nextMsg(), nextMsg(), nextMsg()];

  let viewers = { twitch: 842, kick: 317 };
  const today = new Date(t);
  mock.snapshot({
    state: {
      'show.lineup': lineup,
      'show.headliner': 'VIKKSTAR',
      'show.currentSlot': 1,
      'show.date': today.getFullYear() + '-' + pad(today.getMonth() + 1) + '-' + pad(today.getDate()),
      // Ten minutes away, so a countdown has something to count (an "auto" scene goes live then).
      'show.goLiveAt': t + 10 * MIN,
      'show.recStartedAt': t - 42 * MIN,
      'show.timezone': Intl.DateTimeFormat().resolvedOptions().timeZone,
      // CTD Relay's stream clock (02 §2.5.2): a stream on air for 42 minutes, at 30 fps.
      'stream.clock': { startedAt: t - 42 * MIN - 17250, fps: 30, offsetMs: 0, at: t },
      'music.nowPlaying': tracks[0],
      'viewers.twitch': viewers.twitch,
      'viewers.kick': viewers.kick,
      'viewers.total': viewers.twitch + viewers.kick,
    },
    chat: { recent: recentCount ? backlog.slice(-recentCount) : [] },
  });

  // Chat: a message every 1.5 s, one deleted a few seconds after it appears, and now and then the
  // bot's messages cleared (a ban or timeout).
  every(1500, () => {
    const m = nextMsg();
    mock.push('chat.message', m);
    if (n % 11 === 0) later(3000, () => mock.push('chat.message.deleted', { messageId: m.id }));
    if (n % 23 === 0) mock.push('chat.user.cleared', { userId: 'twitch:8' });
  });

  // Viewers drift. Every sixth update Kick's count is briefly unknown, so templates show what they
  // do when a value is absent (never 0, 02 §2.8); halfway between, the counts are briefly held
  // through an error (viewers.stale).
  let vt = 0;
  every(5000, () => {
    vt++;
    viewers = { twitch: Math.max(0, viewers.twitch + Math.round((Math.random() - 0.45) * 30)), kick: Math.max(0, viewers.kick + Math.round((Math.random() - 0.45) * 12)) };
    const kickKnown = vt % 6 !== 0;
    mock.push('state.changed', { key: 'viewers.twitch', value: viewers.twitch });
    mock.push('state.changed', kickKnown ? { key: 'viewers.kick', value: viewers.kick } : { key: 'viewers.kick' });
    mock.push('state.changed', { key: 'viewers.total', value: viewers.twitch + (kickKnown ? viewers.kick : 0) });
    mock.push('state.changed', vt % 6 === 3 ? { key: 'viewers.stale', value: true } : { key: 'viewers.stale' });
  });

  // A new track every 40 s.
  let ti = 0;
  every(40000, () => {
    ti = (ti + 1) % tracks.length;
    mock.push('state.changed', { key: 'music.nowPlaying', value: Object.assign({}, tracks[ti], { progressAt: now() }) });
  });

  // One alert of every kind, highest priority first, each in its own display window like the
  // server queue gives them (05 §5.5).
  const alertKinds = [
    { kind: 'raid', user: { id: 'twitch:20', name: 'NightRaider' }, amount: { value: 238, unit: 'viewers' } },
    { kind: 'superchat', user: { id: 'youtube:21', name: 'Superfan' }, amount: { value: '20.00', unit: 'currency', currency: 'CAD' }, message: { text: 'play the Strobe edit!', fragments: [{ type: 'text', text: 'play the Strobe edit!' }] } },
    { kind: 'tip', user: { id: 'custom:22', name: 'Anonymous', anonymous: true }, amount: { value: '5.00', unit: 'currency', currency: 'USD' } },
    { kind: 'gift', user: { id: 'twitch:23', name: 'GiftLord' }, amount: { value: 50, unit: 'count' }, tier: '1', gift: { total: 50, recipients: [] }, coalesced: 51 },
    { kind: 'subscription', user: { id: 'kick:24', name: 'LoyalOne' }, amount: { value: 12, unit: 'months' }, tier: '1', message: { text: 'a year of Saturdays', fragments: [{ type: 'text', text: 'a year of Saturdays' }] } },
    { kind: 'membership', user: { id: 'youtube:25', name: 'MemberMike' }, amount: { value: 3, unit: 'months' } },
    { kind: 'cheer', user: { id: 'twitch:26', name: 'BitsBoss' }, amount: { value: 500, unit: 'bits' } },
    { kind: 'kicks', user: { id: 'kick:27', name: 'KickKing' }, amount: { value: 100, unit: 'kicks' } },
    { kind: 'follow', user: { id: 'twitch:28', name: 'NewFace' } },
  ];
  const gapMs = (meta.alerts && meta.alerts.gapMs) || 500;
  let ai = 0;
  let nextStart = 0;
  every(8000, () => {
    const a = alertKinds[ai % alertKinds.length];
    ai++;
    const durationMs = mock.alertDurationMs(); // alerts.durationSetting applies, as on the server
    const startAt = Math.max(now(), nextStart);
    nextStart = startAt + durationMs + gapMs;
    mock.push('alert.' + a.kind, Object.assign({ gift: null }, a, { display: { startAt, durationMs } }));
  });

  // Each declared action once, 20 s apart, then again.
  const actions = meta.actions || [];
  let ac = 0;
  if (actions.length) {
    every(20000, () => {
      const a = actions[ac % actions.length];
      ac++;
      mock.push('show.trigger', { name: a.id, args: Object.assign({ name: lineup[1].name }, a.args || {}), startAt: now(), durationMs: a.durationMs || 7000 });
    });
  }
})();
