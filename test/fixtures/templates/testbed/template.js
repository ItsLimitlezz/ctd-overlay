// Records what the runtime does, for browser tests to read from window.__log.
(() => {
  const log = (window.__log = []);
  const t0 = () => Math.round(SK.clock.now());

  SK.defineScene('lineup', (ctx) => {
    const el = document.createElement('div');
    el.className = 'card';
    el.setAttribute('data-card', '');
    el.textContent = `Lineup for ${ctx.canvas.id}`;
    return el;
  });

  SK.onScene((scene, prev, transition, root) => {
    log.push({ what: 'scene', scene, prev: prev ?? null, transition, root: !!root, at: t0() });
  });

  SK.action('titleCard', ({ args, startAt, durationMs, lateMs }) => {
    log.push({ what: 'titleCard', args, startAt, durationMs, lateMs, at: t0() });
    const el = document.createElement('div');
    el.className = 'title';
    el.textContent = args.name || '';
    SK.mount(el, { offsetMs: lateMs });
    SK.clock.at(startAt + durationMs, () => SK.unmount(el));
  });

  // ?norender: a widget that takes alerts through SK.on only.
  if (!location.search.includes('norender')) {
    SK.alerts.render((alert, el) => {
      el.className = alert.probe ? 'alert probe' : 'alert';
      el.textContent = `${alert.user.name} ${alert.kind}`;
      log.push({ what: 'alert', kind: alert.kind, name: alert.user.name, at: t0() });
    });
  }
  SK.on('alert.*', (env) => log.push({ what: 'alert-event', type: env.type }));

  SK.chat.onAdd((m, info) => {
    const el = document.createElement('div');
    el.className = 'msg';
    el.setAttribute('data-id', m.id);
    el.textContent = m.text;
    log.push({ what: 'chat', id: m.id, initial: info.initial, at: t0() });
    return el;
  });
  SK.chat.onRemove((id) => log.push({ what: 'chat-removed', id }));
  SK.chat.onClear(() => log.push({ what: 'chat-cleared' }));

  SK.onSettings((s) => log.push({ what: 'settings', settings: s }));
  SK.on('custom.*', (env) => log.push({ what: 'event', type: env.type, data: env.data }));

  SK.ready(() => log.push({ what: 'ready', scene: SK.scene, settings: SK.settings, at: t0() }));
})();
