// Shows the state of this browser source's connection. Uses a timer, never
// requestAnimationFrame, so it keeps updating in sources OBS isn't painting (H9).
(() => {
  const $ = (name) => document.querySelector(`[data-${name}]`);
  const pad = (n, w = 2) => String(n).padStart(w, '0');

  $('slug').textContent = SK.meta.slug;

  SK.on('custom.*', (env) => {
    $('last').textContent = env.type;
  });

  SK.onState('custom.diag.counter', (value) => {
    $('counter').textContent = value === undefined ? '—' : String(value);
  });

  setInterval(() => {
    const t = new Date(SK.clock.now());
    $('clock').textContent = `${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}.${pad(t.getMilliseconds(), 3)}`;
    $('skew').textContent = `${Math.round(SK.transport.skew)} ms`;
    $('mode').textContent = SK.transport.mode;
    $('dot').dataset.state = SK.transport.mode;
    $('received').textContent = String(SK.transport.received);
  }, 100);
})();
