// Shared by the connector tests: a hand-cranked clock that lets promises settle between timers, a
// pretend service behind fetch, and a wait in real time for what settles on I/O.

// A clock whose timers run when the test moves it.
export function fakeClock(start = Date.UTC(2026, 9, 17, 20)) {
  const c = { t: start, pending: [] };
  const add = (fn, ms, every) => {
    const h = { at: c.t + Math.max(0, Number(ms) || 0), fn, every, unref() {} };
    c.pending.push(h);
    return h;
  };
  const clear = (h) => {
    const i = c.pending.indexOf(h);
    if (i >= 0) c.pending.splice(i, 1);
  };
  c.timers = { setTimeout: (fn, ms) => add(fn, ms), clearTimeout: clear, setInterval: (fn, ms) => add(fn, ms, Math.max(1, ms)), clearInterval: clear };
  c.now = () => c.t;
  c.flush = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };
  c.advance = async (ms) => {
    const until = c.t + ms;
    for (;;) {
      await c.flush();
      let due = null;
      for (const h of c.pending) if (h.at <= until && (!due || h.at < due.at)) due = h;
      if (!due) break;
      c.t = Math.max(c.t, due.at);
      if (due.every) due.at += due.every;
      else clear(due);
      due.fn();
    }
    c.t = until;
    await c.flush();
  };
  return c;
}

// A pretend service behind fetch: answer(url, init) → { status, body, headers }, 'hang' (until
// aborted), or an Error to throw.
export function fakeFetch(answer = () => ({ status: 404, body: {} })) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', headers: init.headers || {}, body: init.body });
    const a = await answer(new URL(url), init);
    if (a === 'hang') {
      return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    }
    if (a instanceof Error) throw a;
    return new Response(a.body === undefined ? null : JSON.stringify(a.body), { status: a.status ?? 200, headers: { 'content-type': 'application/json', ...(a.headers || {}) } });
  };
  fn.calls = calls;
  return fn;
}

// Waits in real time until fn() is truthy (a connection's work settles on promises and I/O).
export async function until(fn, ms = 5000, what = 'a condition') {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
