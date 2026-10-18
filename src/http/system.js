// The platform itself, and live data, over HTTP (03 §3.4), on the API's conventions (http/api.js):
//
//   GET  /api/v1/openapi.json     this API, described (OpenAPI 3.1); no sign-in needed
//   GET  /api/v1/system/health    status, with what is degraded, and every connection's status and
//                                 viewer count (the Live strip: operators don't hold connections:read)
//   GET  /api/v1/system/info      version, exposure, store, capabilities (ffmpeg …)
//   GET  /api/v1/events           Server-Sent Events of what the platform publishes (?types=alert.*,custom.*)
//   POST /api/v1/events           { type, data }: publish a custom.* or x-<vendor>.* event (02 §2.7),
//                                 60 a second per principal, a budget of its own (03 §3.5)
//   GET  /api/v1/state · GET /api/v1/state/:key   current state
//   PUT  /api/v1/state/:key       { value }: set a custom.* or x-<vendor>.* key (null removes it)
import { ApiError } from './api.js';
import { BASE_HEADERS } from './server.js';
import { compilePatterns, isCustom, KEY } from '../bus/names.js';
import { createSseWriter } from '../overlays/sse.js';

export const PUBLISH_PER_SECOND = 60; // 03 §3.5

export function systemRoutes({ api, bus, store, media, templates, overlays, shows, connectors, config, version, heartbeatMs = 15000, now = Date.now }) {
  const started = now();
  const streams = new Set();
  const r = (def) => api.route({ tag: 'System', ...def });

  async function info() {
    const ffmpeg = await media.ffmpeg();
    return {
      version,
      standard: 'skp/1',
      exposure: config.exposure,
      ...(config.allowPlainInternet ? { plainInternet: true } : {}),
      ...(config.publicUrl ? { publicUrl: config.publicUrl } : {}),
      store: { kind: store.kind, schemaVersion: store.schemaVersion },
      capabilities: { ffmpeg: Boolean(ffmpeg?.available), ...(ffmpeg?.version ? { ffmpegVersion: ffmpeg.version } : {}), tls: Boolean(config.tlsCert) },
      counts: { overlays: overlays.list().length, shows: shows.list().length, templates: new Set(templates.list().map((t) => t.id)).size },
      uptimeS: Math.round((now() - started) / 1000),
    };
  }

  return [
    api.route({ method: 'GET', path: '/api/v1/openapi.json', open: true, tag: 'System', summary: 'This API, described (OpenAPI 3.1)', run: () => api.openapi({ version, base: '/' }) }),
    r({ method: 'GET', path: '/api/v1/system/health', summary: 'Status, what is degraded, and each connection\'s status and viewer count', run: () => {
      const unusable = overlays.list().filter((d) => !overlays.resolve(d.data.slug)?.template).map((d) => d.data.slug);
      // A connection turned on but not connected (an error, a sign-in needed) degrades the whole.
      const connections = connectors?.summary() || [];
      const down = connections.filter((c) => !['connected', 'disabled'].includes(c.status));
      return {
        status: unusable.length || down.length ? 'degraded' : 'ok',
        ...(unusable.length ? { overlaysOffAir: unusable } : {}),
        connections,
        uptimeS: Math.round((now() - started) / 1000),
      };
    } }),
    r({ method: 'GET', path: '/api/v1/system/info', summary: 'Version, exposure, store and capabilities', run: info }),
    // The installation's own name and logo, shown in the admin UI (08 §8.6).
    r({ method: 'GET', path: '/api/v1/system/settings', summary: 'The installation\'s name and logo', run: () => store.get('system', 'settings')?.data || {} }),
    r({ method: 'PUT', path: '/api/v1/system/settings', scope: 'system:admin', command: true, summary: 'Set the installation\'s name and logo', body: { fields: ['name', 'logo'] }, run: ({ body }) => {
      const next = { ...(store.get('system', 'settings')?.data || {}) };
      if (body.name !== undefined) {
        if (body.name !== null && (typeof body.name !== 'string' || body.name.length > 60)) throw new ApiError(422, 'invalid', '"name" is text, at most 60 characters.');
        if (body.name) next.name = body.name.trim();
        else delete next.name;
      }
      if (body.logo !== undefined) {
        if (body.logo !== null && body.logo !== '' && (typeof body.logo !== 'string' || !/^\/media\/[0-9a-f]{32}\/[^/\\?#%\s]+$/.test(body.logo))) throw new ApiError(422, 'invalid', '"logo" is an uploaded image\'s URL (/media/…), or null.');
        if (body.logo) next.logo = body.logo;
        else delete next.logo;
      }
      store.put('system', 'settings', next);
      return next;
    } }),

    r({ method: 'GET', path: '/api/v1/events', scope: 'events:read', tag: 'Live', summary: 'Server-Sent Events of what the platform publishes (?types=)', query: ['types'], produces: 'text/event-stream', run: ({ url, req, res, still }) => {
      let wants = () => true;
      const types = url.searchParams.get('types');
      if (types) {
        try { wants = compilePatterns(types.split(',').map((s) => s.trim()).filter(Boolean), 'type'); } catch (err) { throw new ApiError(422, 'invalid', `"types" is a list like alert.*,custom.*: ${err.message}.`); }
      }
      res.writeHead(200, { ...BASE_HEADERS, 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      res.write(': connected\n\n');
      // A client that stops reading gets a queue, not the server's memory: past its cap the stream
      // is cut (overlays/sse.js), destroyed, as a stalled socket never flushes an end.
      const writer = createSseWriter(res, { onOverflow: () => res.destroy() });
      // The stream outlives the request that opened it: whoever opened it must still be signed in
      // with events:read (not signed out, expired, revoked or removed since). Checked at each
      // heartbeat, and before an event when the last check is a second old.
      let checkedAt = now();
      const holds = (force) => {
        if (!force && now() - checkedAt < 1000) return true;
        checkedAt = now();
        if (still()) return true;
        stop();
        if (res.writableNeedDrain) res.destroy();
        else res.end();
        return false;
      };
      const off = bus.subscribeAll((env) => {
        if (wants(env.type) && holds()) writer.send(env);
      });
      const beat = setInterval(() => {
        if (holds(true)) writer.comment('heartbeat');
      }, heartbeatMs);
      beat.unref?.();
      const stream = { end: () => res.end() };
      streams.add(stream);
      function stop() {
        off();
        writer.close();
        clearInterval(beat);
        streams.delete(stream);
      }
      req.on('close', stop);
    } }),
    r({ method: 'POST', path: '/api/v1/events', scope: 'events:publish', tag: 'Live', summary: 'Publish a custom.* or x-<vendor>.* event', body: { fields: ['type', 'data'], limit: 64 * 1024 }, perSecond: PUBLISH_PER_SECOND, status: 202, run: ({ body, who }) => {
      if (typeof body.type !== 'string' || !isCustom(body.type)) throw new ApiError(422, 'invalid', '"type" must be custom.<name> or x-<vendor>.<name> (02 §2.7).');
      try {
        const env = bus.publish(body.type, body.data ?? {}, { src: { connector: 'api', app: who.label } });
        return { status: 202, body: { id: env.id, type: env.type } };
      } catch (err) {
        if (err.name === 'BusError') throw new ApiError(422, 'invalid', err.message);
        throw err;
      }
    } }),
    // Installation-wide: each key's value from every connection by the bus's one rule, viewers.total
    // the sum over platforms (02 §2.5).
    r({ method: 'GET', path: '/api/v1/state', scope: 'events:read', tag: 'Live', summary: 'Current state, installation-wide', run: () => bus.stateView() }),
    r({ method: 'GET', path: '/api/v1/state/:key', scope: 'events:read', tag: 'Live', summary: 'One state key', run: ({ params }) => {
      const value = bus.getState(params.key);
      if (value === undefined) throw new ApiError(404, 'not-found', `"${params.key}" has no value.`);
      return { key: params.key, value };
    } }),
    r({ method: 'PUT', path: '/api/v1/state/:key', scope: 'state:write', command: true, tag: 'Live', summary: 'Set a custom.* or x-<vendor>.* state key (null removes it)', body: { fields: ['value'], limit: 64 * 1024 }, run: ({ params, body, who }) => {
      if (!KEY.test(params.key) || !isCustom(params.key)) throw new ApiError(422, 'invalid', 'Only custom.* and x-<vendor>.* keys can be set from outside (02 §2.7).');
      if (!('value' in body)) throw new ApiError(422, 'invalid', 'Send { "value": … } (null removes the key).');
      try {
        bus.setState(params.key, body.value === null ? undefined : body.value, { src: { connector: 'api', app: who.label } });
      } catch (err) {
        if (err.name === 'BusError') throw new ApiError(422, 'invalid', err.message);
        throw err;
      }
      return { key: params.key, value: bus.getState(params.key) ?? null };
    } }),
  ].map((route) => (route.path === '/api/v1/events' ? Object.assign(route, { close: () => { for (const s of streams) s.end(); } }) : route));
}
