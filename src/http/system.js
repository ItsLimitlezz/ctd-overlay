// The platform itself, and live data, over HTTP (03 §3.4), on the API's conventions (http/api.js):
//
//   GET  /api/v1/openapi.json     this API, described (OpenAPI 3.1); no sign-in needed
//   GET  /api/v1/system/health    status, with what is degraded
//   GET  /api/v1/system/info      version, exposure, store, capabilities (ffmpeg …)
//   GET  /api/v1/events           Server-Sent Events of what the platform publishes (?types=alert.*,custom.*)
//   POST /api/v1/events           { type, data }: publish a custom.* or x-<vendor>.* event (02 §2.7)
//   GET  /api/v1/state · GET /api/v1/state/:key   current state
//   PUT  /api/v1/state/:key       { value }: set a custom.* or x-<vendor>.* key (null removes it)
import { ApiError } from './api.js';
import { compilePatterns, isCustom, KEY } from '../bus/names.js';
import { frame } from '../overlays/sse.js';

export const PUBLISH_PER_SECOND = 60; // 03 §3.5

export function systemRoutes({ api, bus, store, media, templates, overlays, shows, config, version, heartbeatMs = 15000, now = Date.now }) {
  const started = now();
  const publishes = new Map(); // principal → { second, count }
  const streams = new Set();
  const r = (def) => api.route({ tag: 'System', ...def });

  async function info() {
    const ffmpeg = await media.ffmpeg();
    return {
      version,
      standard: 'skp/1',
      exposure: config.exposure,
      ...(config.publicUrl ? { publicUrl: config.publicUrl } : {}),
      store: { kind: store.kind, schemaVersion: store.schemaVersion },
      capabilities: { ffmpeg: Boolean(ffmpeg?.available), ...(ffmpeg?.version ? { ffmpegVersion: ffmpeg.version } : {}), tls: Boolean(config.tlsCert) },
      counts: { overlays: overlays.list().length, shows: shows.list().length, templates: new Set(templates.list().map((t) => t.id)).size },
      uptimeS: Math.round((now() - started) / 1000),
    };
  }

  return [
    api.route({ method: 'GET', path: '/api/v1/openapi.json', open: true, tag: 'System', summary: 'This API, described (OpenAPI 3.1)', run: () => api.openapi({ version, base: '/' }) }),
    r({ method: 'GET', path: '/api/v1/system/health', summary: 'Status, and what is degraded', run: () => {
      const unusable = overlays.list().filter((d) => !overlays.resolve(d.data.slug)?.template).map((d) => d.data.slug);
      return { status: unusable.length ? 'degraded' : 'ok', ...(unusable.length ? { overlaysOffAir: unusable } : {}), uptimeS: Math.round((now() - started) / 1000) };
    } }),
    r({ method: 'GET', path: '/api/v1/system/info', summary: 'Version, exposure, store and capabilities', run: info }),

    r({ method: 'GET', path: '/api/v1/events', scope: 'events:read', tag: 'Live', summary: 'Server-Sent Events of what the platform publishes (?types=)', run: ({ url, req, res }) => {
      let wants = () => true;
      const types = url.searchParams.get('types');
      if (types) {
        try { wants = compilePatterns(types.split(',').map((s) => s.trim()).filter(Boolean), 'type'); } catch (err) { throw new ApiError(422, 'invalid', `"types" is a list like alert.*,custom.*: ${err.message}.`); }
      }
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      res.write(': connected\n\n');
      const off = bus.subscribeAll((env) => {
        if (wants(env.type)) res.write(frame(env));
      });
      const beat = setInterval(() => res.write(': heartbeat\n\n'), heartbeatMs);
      beat.unref?.();
      const stream = { end: () => res.end() };
      streams.add(stream);
      req.on('close', () => {
        off();
        clearInterval(beat);
        streams.delete(stream);
      });
    } }),
    r({ method: 'POST', path: '/api/v1/events', scope: 'events:publish', tag: 'Live', summary: 'Publish a custom.* or x-<vendor>.* event', body: { fields: ['type', 'data'], limit: 64 * 1024 }, run: ({ body, who }) => {
      if (typeof body.type !== 'string' || !isCustom(body.type)) throw new ApiError(422, 'invalid', '"type" must be custom.<name> or x-<vendor>.<name> (02 §2.7).');
      const key = `${who.kind}:${who.tokenId || who.user?.id || 'local'}`;
      const second = Math.floor(now() / 1000);
      let w = publishes.get(key);
      if (!w || w.second !== second) publishes.set(key, (w = { second, count: 0 }));
      if (++w.count > PUBLISH_PER_SECOND) throw new ApiError(429, 'rate-limited', `At most ${PUBLISH_PER_SECOND} events a second.`, { headers: { 'retry-after': '1' } });
      try {
        const env = bus.publish(body.type, body.data ?? {}, { src: { connector: 'api', app: who.label } });
        return { status: 202, body: { id: env.id, type: env.type } };
      } catch (err) {
        if (err.name === 'BusError') throw new ApiError(422, 'invalid', err.message);
        throw err;
      }
    } }),
    r({ method: 'GET', path: '/api/v1/state', scope: 'events:read', tag: 'Live', summary: 'Current state', run: () => Object.fromEntries([...bus.stateEntries()].map(([k, v]) => [k, v.value])) }),
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
