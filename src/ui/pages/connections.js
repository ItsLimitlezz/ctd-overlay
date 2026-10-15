// Connections (08 §8.1, §8.7): Twitch, Kick, YouTube, Spotify, OBS and custom hooks, their status
// and setup. The connector host arrives in step 16; until then this says what is coming and what
// already works without one.
import { h, mount, pageHead } from '../dom.js';

const SERVICES = [
  { name: 'Twitch', what: 'Viewer count, live status, chat and alerts' },
  { name: 'Kick', what: 'Viewer count, live status, chat and alerts' },
  { name: 'YouTube', what: 'Viewer count, live status and chat' },
  { name: 'Spotify', what: 'Now playing' },
  { name: 'OBS', what: 'Scenes follow OBS, and "Add to OBS" makes browser sources' },
  { name: 'Webhooks and custom hooks', what: 'Other apps send events and state, or hear about yours' },
];

export function list(view, ctx) {
  ctx.setTitle('Connections');
  mount(view,
    pageHead('Connections'),
    h('div.notice', 'Connections to streaming services come in a later version of this platform. Until then, overlays show everything else: scenes, the lineup, timers and title cards. Other apps can already send custom events and state through the API (POST /api/v1/events, PUT /api/v1/state/…) with an API token from Settings.'),
    h('div.grid', SERVICES.map((s) => h('div.card',
      h('div.card-head', h('span.dot', { role: 'img', 'aria-label': 'Not connected' }), h('h2', s.name)),
      h('p.muted', s.what),
      h('span.badge', 'Not available yet')))));
}
