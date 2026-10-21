// The show API (03 §3.4), on the API's conventions (http/api.js): signed in with a scope, JSON
// with known fields only, ETag and If-Match on shows, cues and plans, paged lists, and instants
// as ISO 8601 (epoch ms is for live envelopes only, 03 §3.1).
//
//   GET    /api/v1/shows                           every show, paged
//   POST   /api/v1/shows                           { name, overlays, date, timezone, dayBoundary?, goLive?, lineup?, followObs? }
//   GET    /api/v1/shows/:ref                      by id or name
//   PATCH  /api/v1/shows/:ref                      any of the above (If-Match)
//   DELETE /api/v1/shows/:ref
//   PUT    /api/v1/shows/:ref/scene                { scene, transition? }: on every member (a command)
//   POST   /api/v1/shows/:ref/triggers/:name       { args? }: to every member with the action
//   PUT    /api/v1/shows/:ref/slot                 { slot }: a lineup position or act, or null
//   POST   /api/v1/shows/:ref/rec                  { action: "start" | "reset" }
//   GET    /api/v1/shows/:ref/cues                 the timeline (09 §9.3), paged
//   POST   /api/v1/shows/:ref/cues                 { at: "HH:MM" | ISO, action, label? }
//   POST   /api/v1/shows/:ref/cues/build           { recipe? }: generate cues from the lineup (09 §9.5)
//   GET    /api/v1/shows/:ref/cues/:cueId
//   PATCH  /api/v1/shows/:ref/cues/:cueId          { at?, action?, label? } (If-Match)
//   DELETE /api/v1/shows/:ref/cues/:cueId
//   POST   /api/v1/shows/:ref/cues/:cueId/fire|skip|rearm   operator overrides (09 §9.4)
//   GET    /api/v1/shows/:ref/plans · POST (a planned show, 09 §9.6) · DELETE …/plans/:planId
//   PUT    /api/v1/overlays/:ref/scene             an overlay outside a show
//   POST   /api/v1/overlays/:ref/actions/:name     one overlay's action
//
// Reading needs timeline:read; changing a show, its cues or plans timeline:write; taking scenes,
// triggers, the slot, REC and cue overrides overlays:control (07 §7.5, 03 §3.3).
//
// A show as answered carries `stream` (src/streams.js): the connections its members are fed by,
// whether it is on air on each platform and its viewers, worked out on each read. `live` stays what
// it was: REC is running (recStartedAt), which is not the same as being on air on a platform.
//
// followObs (09 §9.7): which OBS canvas drives the show's scene, whose OBS, and OBS scene → scene;
// an edit like the others (If-Match). sceneByObs: the last take was OBS's (src/obs/follow.js).
import { FOLLOW_OBS_FIELDS } from '../obs/mapping.js';

const READ = 'timeline:read';
const WRITE = 'timeline:write';
const CONTROL = 'overlays:control';
const SHOW_FIELDS = ['name', 'overlays', 'date', 'timezone', 'dayBoundary', 'goLive', 'lineup', 'followObs'];
const SHOW_BODY = { fields: SHOW_FIELDS, nested: { followObs: FOLLOW_OBS_FIELDS } };
const iso = (ms) => (typeof ms === 'number' ? new Date(ms).toISOString() : ms);

// A show as a resource: its instants as ISO 8601.
export function showResource(s) {
  const out = { ...s };
  delete out.actor;
  for (const k of ['goLiveAt', 'recStartedAt', 'sceneTakenAt']) if (out[k] !== undefined) out[k] = iso(out[k]);
  if (out.sceneReturn) out.sceneReturn = { ...out.sceneReturn, at: iso(out.sceneReturn.at) };
  if (out.sceneByObs) out.sceneByObs = { ...out.sceneByObs, at: iso(out.sceneByObs.at) };
  if (out.lineup) out.lineup = out.lineup.map((slot) => ({ ...slot, startAt: iso(slot.startAt) }));
  return out;
}
const cueKey = (c) => `${c.at}|${String(c.order).padStart(2, '0')}|${c.id}`;

export function showRoutes({ api, shows, timeline, streams }) {
  const tag = 'Shows';
  const showRev = (p) => {
    const s = shows.get(p.ref);
    return { id: s.id, rev: s.rev };
  };
  // The show with its stream status (not part of its ETag: worked out, like live).
  const answer = (s) => (streams ? { ...showResource(s), stream: streams.ofShow(s) } : showResource(s));
  const r = (def) => api.route({ tag, ...def });
  return [
    r({ method: 'GET', path: '/api/v1/shows', scope: READ, summary: 'List shows, each with its stream status (what feeds it, on air or not, viewers)', paged: true, run: ({ url }) => api.paginate(shows.list().map(answer), url) }),
    r({ method: 'POST', path: '/api/v1/shows', scope: WRITE, summary: 'Create a show', body: SHOW_BODY, status: 201, run: ({ body, who }) => ({ status: 201, body: answer(shows.create(body, { actor: who.label })) }) }),
    r({ method: 'GET', path: '/api/v1/shows/:ref', scope: READ, summary: 'A show, by id or name, with its stream status', run: ({ params }) => answer(shows.get(params.ref)) }),
    r({ method: 'PATCH', path: '/api/v1/shows/:ref', scope: WRITE, summary: 'Change a show', body: SHOW_BODY, resource: showRev, run: ({ params, body, ifRev }) => answer(shows.update(params.ref, body, { ifRev })) }),
    r({ method: 'DELETE', path: '/api/v1/shows/:ref', scope: WRITE, summary: 'Delete a show', resource: showRev, run: ({ params }) => shows.remove(params.ref) }),
    r({ method: 'PUT', path: '/api/v1/shows/:ref/scene', scope: CONTROL, command: true, summary: 'Take a scene on every member', body: { fields: ['scene', 'transition'] }, run: ({ params, body, who }) => answer(shows.take(params.ref, body.scene, { transition: body.transition ?? 'fade', actor: who.label })) }),
    r({ method: 'POST', path: '/api/v1/shows/:ref/triggers/:name', scope: CONTROL, command: true, summary: 'Fire an action on every member that has it', body: { fields: ['args'] }, run: ({ params, body, who }) => {
      const out = shows.trigger(params.ref, params.name, { args: body.args ?? {}, actor: who.label });
      return { ...out, startAt: iso(out.startAt) };
    } }),
    r({ method: 'PUT', path: '/api/v1/shows/:ref/slot', scope: CONTROL, command: true, summary: 'Who is on: a lineup position, an act, or null', body: { fields: ['slot'] }, run: ({ params, body }) => answer(shows.setSlot(params.ref, body.slot === undefined ? undefined : body.slot)) }),
    r({ method: 'POST', path: '/api/v1/shows/:ref/rec', scope: CONTROL, command: true, summary: 'Start or reset REC', body: { fields: ['action'] }, run: ({ params, body }) => answer(shows.rec(params.ref, body.action)) }),
    // The timeline (09 §9.3–9.6).
    r({ method: 'GET', path: '/api/v1/shows/:ref/cues', scope: READ, summary: 'The show\'s cues, in time order', paged: true, run: ({ params, url }) => api.paginate(timeline.list(params.ref), url, cueKey) }),
    r({ method: 'POST', path: '/api/v1/shows/:ref/cues', scope: WRITE, summary: 'Add a cue', body: { fields: ['at', 'action', 'label'] }, status: 201, run: ({ params, body, who }) => ({ status: 201, body: timeline.add(params.ref, body, { actor: who.label }) }) }),
    r({ method: 'POST', path: '/api/v1/shows/:ref/cues/build', scope: WRITE, summary: 'Generate cues from the lineup with a recipe', body: { fields: ['recipe'] }, run: ({ params, body }) => ({ items: timeline.build(params.ref, body.recipe) }) }),
    r({ method: 'GET', path: '/api/v1/shows/:ref/cues/:cueId', scope: READ, summary: 'A cue', run: ({ params }) => timeline.get(params.ref, params.cueId) }),
    r({ method: 'PATCH', path: '/api/v1/shows/:ref/cues/:cueId', scope: WRITE, summary: 'Change a cue', body: { fields: ['at', 'action', 'label'] }, resource: (p) => timeline.get(p.ref, p.cueId), run: ({ params, body }) => timeline.update(params.ref, params.cueId, body) }),
    r({ method: 'DELETE', path: '/api/v1/shows/:ref/cues/:cueId', scope: WRITE, summary: 'Delete a cue', resource: (p) => timeline.get(p.ref, p.cueId), run: ({ params }) => timeline.remove(params.ref, params.cueId) }),
    r({ method: 'POST', path: '/api/v1/shows/:ref/cues/:cueId/:op', scope: CONTROL, command: true, summary: 'Fire now, skip or re-arm a cue (op: fire | skip | rearm)', body: { fields: [] }, run: ({ params, who }) => timeline.override(params.ref, params.cueId, params.op, { actor: who.label }) }),
    r({ method: 'GET', path: '/api/v1/shows/:ref/plans', scope: READ, summary: 'The show\'s planned dates', paged: true, run: ({ params, url }) => api.paginate(timeline.plans.list(params.ref), url, (p) => `${p.date}|${p.id}`) }),
    r({ method: 'POST', path: '/api/v1/shows/:ref/plans', scope: WRITE, summary: 'Plan the show for a date', body: { fields: ['date', 'lineup', 'goLive', 'dayBoundary', 'overlaySettings'] }, status: 201, run: ({ params, body }) => ({ status: 201, body: timeline.plans.add(params.ref, body) }) }),
    r({ method: 'DELETE', path: '/api/v1/shows/:ref/plans/:planId', scope: WRITE, summary: 'Delete a plan', run: ({ params }) => timeline.plans.remove(params.ref, params.planId) }),
    r({ method: 'PUT', path: '/api/v1/overlays/:ref/scene', scope: CONTROL, command: true, tag: 'Overlays', summary: 'Take a scene on an overlay outside a show', body: { fields: ['scene', 'transition'] }, run: ({ params, body, who }) => shows.takeOverlay(params.ref, body.scene, { transition: body.transition ?? 'fade', actor: who.label }) }),
    r({ method: 'POST', path: '/api/v1/overlays/:ref/actions/:name', scope: CONTROL, command: true, tag: 'Overlays', summary: 'Fire an overlay\'s action', body: { fields: ['args'] }, run: ({ params, body, who }) => {
      const out = shows.fireOverlay(params.ref, params.name, { args: body.args ?? {}, actor: who.label });
      return { ...out, startAt: iso(out.startAt) };
    } }),
  ];
}
