// A connector for tests: every sign-in kind, and behaviours chosen per connection by its
// "behaviour" setting, so one platform can run a well-behaved connection beside a broken one.
//
//   ok           GET <api>/viewers (with the account's token when signed in, the app's for
//                client credentials) at start and every pollMs: viewers.twitch, or a hold when it
//                fails; stream.twitch.live from the same answer
//   fail-start   start() throws
//   reject       start() rejects
//   hang         start() never finishes
//   throw-later  starts, then a timer it set throws
//   quota        starts, then says its quota is spent for a minute
//   push         starts and waits: the test publishes through it (fake.live)
//   secret-error start() fails with a message that holds its client secret
//
// Actions: echo (answers its args), slow (never finishes), fail (throws), admin (needs
// connections:write). test() answers ok. inbound() accepts a delivery signed "good".
// fromV0() takes what the v0 importer kept for Twitch.
export const FAKE_ENDPOINTS = { api: 'https://fake.example/api' };
export const FAKE_OAUTH = {
  authorizeUrl: 'https://fake.example/authorize',
  tokenUrl: 'https://fake.example/token',
  deviceUrl: 'https://fake.example/device',
  revokeUrl: 'https://fake.example/revoke',
  scopes: [{ scope: 'viewers:read', why: 'To read the viewer count.' }],
};

export function fakeConnector({ id = 'fake', name = 'Fake', auth = 'none', userAuth, platform = 'twitch', guide, holdOnError, relay, inbound = true } = {}) {
  const live = []; // { ctx, push(type, data, opts) } of every instance made, newest last
  const oauth = ['device-code', 'oauth-pkce', 'oauth-code', 'client-credentials'].includes(auth) ? { ...FAKE_OAUTH } : undefined;
  if (oauth && auth === 'device-code') delete oauth.authorizeUrl;
  const def = {
    id, name, platform, auth,
    ...(userAuth ? { userAuth } : {}),
    ...(relay ? { relay: true } : {}),
    ...(holdOnError === false ? { holdOnError: false } : {}),
    capabilities: ['chat.read', 'alerts', 'viewers', 'stream.status'],
    ...(oauth ? { oauth } : {}),
    endpoints: { ...FAKE_ENDPOINTS },
    fields: {
      type: 'object',
      properties: {
        behaviour: { type: 'string', title: 'Behaviour', enum: ['ok', 'fail-start', 'reject', 'hang', 'throw-later', 'quota', 'push', 'secret-error'], default: 'ok' },
        pollMs: { type: 'integer', title: 'Poll every (ms)', minimum: 20, maximum: 600000, default: 1000 },
        channel: { type: 'string', title: 'Channel', maxLength: 40 },
        clientId: { type: 'string', title: 'Client ID', maxLength: 100, 'x-skp-reauth': true },
        clientSecret: { type: 'string', title: 'Client secret', writeOnly: true, maxLength: 100 },
        host: { type: 'string', title: 'Host', 'x-skp-egress': 'lan' },
      },
    },
    guide: guide || {
      before: 'A connector for tests.',
      steps: ['Register an app with the redirect URI {redirectUri}.', 'Paste its client ID and secret.'],
      warnings: [{ text: 'Always shown.' }, { when: 'lan', text: 'Shown in lan mode.' }, { when: 'no-public-url', text: 'Shown without a public URL.' }],
    },
    actions: {
      echo: { label: 'Echo', args: { type: 'object', properties: { text: { type: 'string', maxLength: 20 } }, additionalProperties: false } },
      slow: { label: 'Slow' },
      fail: { label: 'Fail' },
      admin: { label: 'Admin only', scope: 'connections:write' },
    },
    identify: async (ctx) => (await ctx.http.request(`${ctx.endpoints.api}/me`, { auth: 'user' })).data,
    fromV0: (pending, { secret }) => (pending.platform === platform ? { name: `${name} (${pending.channel})`, config: { channel: pending.channel, clientId: pending.clientId }, secrets: secret ? { clientSecret: secret } : {} } : undefined),
    ...(inbound ? {
      inbound: async (ctx, req) => {
        if (req.headers['x-fake-signature'] !== 'good') return { status: 401 };
        const body = JSON.parse(req.body.toString('utf8'));
        ctx.publish('chat.message', { id: body.id, user: { id: `${platform}:1`, name: 'Hooked', roles: [] }, text: body.text, fragments: [{ type: 'text', text: body.text }] }, { dedupeKey: body.id });
        return { status: 204 };
      },
    } : {}),
    create(ctx) {
      const cfg = ctx.connection.config;
      const authKind = ctx.auth.hasUser() ? 'user' : auth === 'client-credentials' ? 'app' : 'none';
      const poll = async () => {
        let r;
        try {
          r = await ctx.http.request(`${ctx.endpoints.api}/viewers`, { auth: authKind, query: { channel: cfg.channel } });
        } catch (err) {
          if (err.code === 'stopped') return;
          if (err.code === 'needs-reauth') throw err;
          ctx.hold();
          ctx.setHealth({ status: 'degraded', detail: `Viewer count unavailable: ${err.message}` });
          return;
        }
        ctx.setState(`viewers.${platform}`, r.data?.viewers ?? undefined);
        if (typeof r.data?.live === 'boolean') ctx.setState(`stream.${platform}.live`, r.data.live);
        ctx.setHealth({ status: 'connected', detail: 'Reading the viewer count.' });
      };
      const inst = {
        ctx,
        push: (type, data, opts) => ctx.publish(type, data, opts),
        async start() {
          switch (cfg.behaviour) {
            case 'fail-start': throw new Error('cannot start');
            case 'reject': return Promise.reject(new Error('rejected at start'));
            case 'hang': return new Promise(() => {});
            case 'secret-error': throw new Error(`the service refused ${ctx.connection.secrets.clientSecret}`);
            case 'throw-later':
              ctx.schedule(500, () => { throw new Error('a timer crashed'); });
              return undefined;
            case 'quota':
              ctx.schedule(10, () => ctx.quota.exhausted({ resetsAt: ctx.now() + 60000, detail: 'The daily quota is used up; it resets in a minute.' }));
              return undefined;
            case 'push':
              return undefined;
            default:
              await poll();
              ctx.every(cfg.pollMs, poll);
              return undefined;
          }
        },
        stop() { inst.stopped = true; },
        test: () => ({ ok: true, detail: 'The fake service answers.' }),
        actions: {
          echo: (args) => ({ echoed: args.text ?? null }),
          slow: () => new Promise(() => {}),
          fail: () => { throw new Error('the fake service said no'); },
          admin: () => ({ done: true }),
        },
      };
      live.push(inst);
      return inst;
    },
  };
  return { def, live };
}
