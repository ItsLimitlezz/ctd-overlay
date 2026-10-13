// The show API (03 §3.4):
//
//   GET    /api/v1/shows                           every show, with resolved times and live
//   POST   /api/v1/shows                           { name, overlays, date, timezone, dayBoundary?, goLive?, lineup? }
//   GET    /api/v1/shows/:ref                      by id or name
//   PATCH  /api/v1/shows/:ref                      any of the above
//   DELETE /api/v1/shows/:ref
//   PUT    /api/v1/shows/:ref/scene                { scene, transition? }: on every member
//   POST   /api/v1/shows/:ref/triggers/:name       { args? }: to every member with the action
//   PUT    /api/v1/shows/:ref/slot                 { slot }: a lineup position or act, or null
//   POST   /api/v1/shows/:ref/rec                  { action: "start" | "reset" }
//   GET    /api/v1/shows/:ref/cues                 the timeline (09 §9.3)
//   POST   /api/v1/shows/:ref/cues                 { at: "HH:MM" | ISO, action, label? }
//   POST   /api/v1/shows/:ref/cues/build           { recipe? }: generate cues from the lineup (09 §9.5)
//   PATCH  /api/v1/shows/:ref/cues/:cueId          { at?, action?, label? }
//   DELETE /api/v1/shows/:ref/cues/:cueId
//   POST   /api/v1/shows/:ref/cues/:cueId/fire|skip|rearm   operator overrides (09 §9.4)
//   GET    /api/v1/shows/:ref/plans · POST (a planned show, 09 §9.6) · DELETE …/plans/:planId
//   PUT    /api/v1/overlays/:ref/scene             an overlay outside a show
//   POST   /api/v1/overlays/:ref/actions/:name     one overlay's action
//
// Reading needs timeline:read; changing a show, its cues or plans timeline:write; taking scenes,
// triggers, the slot, REC and cue overrides overlays:control (07 §7.5, 03 §3.3).
import { jsonBody } from '../http/local.js';
import { sendJson, sendProblem } from '../http/server.js';
import { ShowError } from './registry.js';

const BODY_LIMIT = 64 * 1024;
const TITLES = { 404: 'Not found', 409: 'Conflict', 422: 'Not possible' };
const READ = 'timeline:read';
const WRITE = 'timeline:write';
const CONTROL = 'overlays:control';

export function showRoutes({ shows, timeline, guard, log }) {
  // Every route: signed in with its scope (auth/routes.js), the JSON body, and ShowErrors as
  // problems. run(params, body, actor): actor is who asked, for the log and the audit log.
  const route = (method, path, scope, run) => ({
    method,
    path,
    async handler({ req, res, params }) {
      const who = guard(req, res, scope);
      if (!who) return;
      const body = method === 'GET' || method === 'DELETE' ? {} : await jsonBody(req, res, BODY_LIMIT);
      if (body === undefined) return;
      if (!body || typeof body !== 'object' || Array.isArray(body)) return sendProblem(res, 400, 'Bad request', 'The body must be a JSON object.');
      try {
        const [status, value] = run(params, body, who.label);
        sendJson(res, status, value);
      } catch (err) {
        if (err instanceof ShowError) return sendProblem(res, err.status, TITLES[err.status] || 'Refused', err.message, { type: `https://skp.dev/errors/${err.code}` });
        if (err.name === 'ConflictError') return sendProblem(res, 409, 'conflict', 'The show changed meanwhile; read it again and retry.');
        log.error('a show request failed', { method, path, err });
        throw err;
      }
    },
  });
  return [
    route('GET', '/api/v1/shows', READ, () => [200, shows.list()]),
    route('POST', '/api/v1/shows', WRITE, (_p, body, actor) => [201, shows.create(body, { actor })]),
    route('GET', '/api/v1/shows/:ref', READ, (p) => [200, shows.get(p.ref)]),
    route('PATCH', '/api/v1/shows/:ref', WRITE, (p, body) => [200, shows.update(p.ref, body)]),
    route('DELETE', '/api/v1/shows/:ref', WRITE, (p) => [200, shows.remove(p.ref)]),
    route('PUT', '/api/v1/shows/:ref/scene', CONTROL, (p, body, actor) => [200, shows.take(p.ref, body.scene, { transition: body.transition ?? 'fade', actor })]),
    route('POST', '/api/v1/shows/:ref/triggers/:name', CONTROL, (p, body, actor) => [200, shows.trigger(p.ref, p.name, { args: body.args ?? {}, actor })]),
    route('PUT', '/api/v1/shows/:ref/slot', CONTROL, (p, body) => [200, shows.setSlot(p.ref, body.slot === undefined ? undefined : body.slot)]),
    route('POST', '/api/v1/shows/:ref/rec', CONTROL, (p, body) => [200, shows.rec(p.ref, body.action)]),
    // The timeline (09 §9.3–9.6).
    route('GET', '/api/v1/shows/:ref/cues', READ, (p) => [200, timeline.list(p.ref)]),
    route('POST', '/api/v1/shows/:ref/cues', WRITE, (p, body, actor) => [201, timeline.add(p.ref, body, { actor })]),
    route('POST', '/api/v1/shows/:ref/cues/build', WRITE, (p, body) => [200, timeline.build(p.ref, body.recipe)]),
    route('PATCH', '/api/v1/shows/:ref/cues/:cueId', WRITE, (p, body) => [200, timeline.update(p.ref, p.cueId, body)]),
    route('DELETE', '/api/v1/shows/:ref/cues/:cueId', WRITE, (p) => [200, timeline.remove(p.ref, p.cueId)]),
    route('POST', '/api/v1/shows/:ref/cues/:cueId/:op', CONTROL, (p, _body, actor) => [200, timeline.override(p.ref, p.cueId, p.op, { actor })]),
    route('GET', '/api/v1/shows/:ref/plans', READ, (p) => [200, timeline.plans.list(p.ref)]),
    route('POST', '/api/v1/shows/:ref/plans', WRITE, (p, body) => [201, timeline.plans.add(p.ref, body)]),
    route('DELETE', '/api/v1/shows/:ref/plans/:planId', WRITE, (p) => [200, timeline.plans.remove(p.ref, p.planId)]),
    route('PUT', '/api/v1/overlays/:ref/scene', CONTROL, (p, body, actor) => [200, shows.takeOverlay(p.ref, body.scene, { transition: body.transition ?? 'fade', actor })]),
    route('POST', '/api/v1/overlays/:ref/actions/:name', CONTROL, (p, body, actor) => [200, shows.fireOverlay(p.ref, p.name, { args: body.args ?? {}, actor })]),
  ];
}
