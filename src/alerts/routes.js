// The alert queue over HTTP (03 §3.4, 05 §5.5), on the API's conventions (http/api.js):
//
//   GET  /api/v1/alerts              every queue: what is on screen and what waits, and whether paused
//   POST /api/v1/alerts/pause        hold alerts (they keep queueing)
//   POST /api/v1/alerts/resume       play them again
//   POST /api/v1/alerts/skip         { queue? } end the alert on screen now (every queue's without one)
//   POST /api/v1/alerts/replay       { queue? } show the last alert again
//
// A queue is a show's (its members share it) or, outside a show, an overlay's own: `queue` is the
// show's id or the overlay's. Commands need overlays:control, like taking a scene.
import { ApiError } from '../http/api.js';

export function alertRoutes({ api, alerts, overlays, shows }) {
  const tag = 'Alerts';
  const r = (def) => api.route({ tag, ...def });
  // A queue as people know it: the show's name, or the overlay's.
  const nameOf = (group) => {
    const show = shows.list().find((s) => s.id === group);
    if (show) return { kind: 'show', name: show.name };
    const doc = overlays.list().find((d) => d.id === group);
    return doc ? { kind: 'overlay', name: doc.data.slug } : { kind: 'overlay', name: group };
  };
  const view = () => ({
    paused: alerts.paused,
    queues: alerts.list().map((q) => ({ queue: q.group, ...nameOf(q.group), showing: q.showing, waiting: q.waiting })),
  });
  const known = (queue) => {
    if (queue !== undefined && (typeof queue !== 'string' || !alerts.list().some((q) => q.group === queue))) {
      throw new ApiError(404, 'not-found', 'There is no alert queue with that id: it has none until an alert reaches it.');
    }
    return queue;
  };
  return [
    r({ method: 'GET', path: '/api/v1/alerts', scope: 'overlays:read', summary: 'The alert queues: on screen, waiting, paused', run: () => view() }),
    r({ method: 'POST', path: '/api/v1/alerts/pause', scope: 'overlays:control', command: true, summary: 'Hold alerts; they keep queueing', body: { fields: [] }, run: () => { alerts.pause(); return view(); } }),
    r({ method: 'POST', path: '/api/v1/alerts/resume', scope: 'overlays:control', command: true, summary: 'Play held alerts', body: { fields: [] }, run: () => { alerts.resume(); return view(); } }),
    r({ method: 'POST', path: '/api/v1/alerts/skip', scope: 'overlays:control', command: true, summary: 'End the alert on screen now', body: { fields: ['queue'] }, run: ({ body }) => { alerts.skip(known(body.queue)); return view(); } }),
    r({ method: 'POST', path: '/api/v1/alerts/replay', scope: 'overlays:control', command: true, summary: 'Show the last alert again', body: { fields: ['queue'] }, run: ({ body }) => {
      if (!alerts.replay(known(body.queue))) throw new ApiError(409, 'nothing-to-replay', 'No alert has been shown yet.');
      return view();
    } }),
  ];
}
