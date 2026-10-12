// The whole integration with every connected platform's viewer count (04 §4.12): the platform sums
// them into viewers.total and removes the key when it doesn't know (H6), so absent means hidden.
SK.ready(() => {
  const paint = () => {
    const el = document.querySelector('.viewers');
    if (!el) return;
    const v = SK.state('viewers.total');
    el.hidden = typeof v !== 'number'; // absent → hidden, never "0"
    if (typeof v === 'number') el.querySelector('b').textContent = v.toLocaleString('en-US');
    el.classList.toggle('stale', SK.state('viewers.stale') === true);
    el.querySelector('.label').textContent = SK.settings.label || '';
    document.documentElement.style.setProperty('--dot', SK.settings.accent || '#ff2a2a');
  };
  SK.onState('viewers.total', paint);
  SK.onState('viewers.stale', paint);
  SK.onSettings(paint);
  SK.onScene(paint);
});
