// Sign in, and the first run's owner account (07 §7.2–7.4).
import * as api from '../api.js';
import { field, h, mount, notice } from '../dom.js';

const brand = () => h('div.brand', h('span.brand-mark', { 'aria-hidden': 'true' }), h('span', 'Stream Kit'));

// Where to go after signing in: the page asked for, if it is one of ours.
const nextOf = (ctx) => {
  const next = ctx.query.get('next');
  return next && /^\/[a-z]/.test(next) && !next.startsWith('/login') && !next.startsWith('/setup') ? next : '/live';
};

export async function login(view, ctx) {
  // No owner yet: setup instead.
  try {
    if ((await api.get('/api/v1/setup')).needed) return ctx.navigate('/setup', { replace: true });
  } catch { /* sign in anyway */ }

  const username = h('input', { type: 'text', name: 'username', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', required: true });
  const password = h('input', { type: 'password', name: 'password', autocomplete: 'current-password', required: true });
  const code = h('input', { type: 'text', name: 'code', autocomplete: 'one-time-code', inputmode: 'numeric', spellcheck: 'false' });
  const keep = h('input', { type: 'checkbox', name: 'keep' });
  const codeField = field('Two-factor code', code, { hint: 'The six digits from your authenticator app, or a recovery code.' });
  codeField.hidden = true;
  const message = h('div', { 'aria-live': 'polite' });
  const submit = h('button.btn.primary.block', { type: 'submit' }, 'Sign in');

  const form = h('form', { novalidate: true },
    field('Username', username),
    field('Password', password),
    codeField,
    field('Keep me signed in on this device', keep, { hint: 'For 30 days. Leave off on a shared computer.' }),
    message,
    submit);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (submit.disabled) return;
    mount(message);
    if (!username.value.trim() || !password.value) {
      mount(message, notice('Enter your username and password.', 'danger'));
      return;
    }
    submit.disabled = true;
    submit.classList.add('busy');
    try {
      await api.post('/api/v1/auth/login', {
        username: username.value.trim().toLowerCase(),
        password: password.value,
        ...(code.value.trim() ? { code: code.value.trim() } : {}),
        keep: keep.checked,
      });
      await ctx.signedIn(nextOf(ctx));
    } catch (err) {
      if (err.code === 'totp-required') {
        codeField.hidden = false;
        mount(message, notice(err.message, 'warn'));
        code.focus();
      } else {
        mount(message, notice(err.message, 'danger'));
        if (err.code === 'bad-credentials') password.select();
      }
    } finally {
      submit.disabled = false;
      submit.classList.remove('busy');
    }
  });

  mount(view, h('div.card.auth-card', brand(), h('h1', 'Sign in'), form));
  username.focus();
}

export async function setup(view, ctx) {
  let needed = true;
  try { needed = (await api.get('/api/v1/setup')).needed; } catch { /* show the form; the server decides */ }
  if (!needed) return ctx.navigate('/login', { replace: true });

  const code = h('input', { type: 'text', name: 'code', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'none', required: true });
  const username = h('input', { type: 'text', name: 'username', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', required: true, pattern: '[a-z0-9][a-z0-9._\\-]{0,63}' });
  const password = h('input', { type: 'password', name: 'password', autocomplete: 'new-password', required: true, minlength: 12 });
  const again = h('input', { type: 'password', name: 'again', autocomplete: 'new-password', required: true });
  const message = h('div', { 'aria-live': 'polite' });
  const submit = h('button.btn.primary.block', { type: 'submit' }, 'Create the owner account');

  const form = h('form', { novalidate: true },
    field('Setup code', code, { hint: 'Printed in the platform\'s log when it started ("setup code"). It works for an hour.' }),
    field('Username', username, { hint: 'Lower-case letters, digits, dots, dashes and underscores.' }),
    field('Password', password, { hint: 'At least 12 characters; a few words make a good one.' }),
    field('Password again', again),
    message,
    submit);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (submit.disabled) return;
    mount(message);
    const problems = [];
    if (!code.value.trim()) problems.push('Enter the setup code from the log.');
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(username.value.trim().toLowerCase())) problems.push('Choose a username: lower-case letters, digits, dots, dashes and underscores.');
    if (password.value.length < 12) problems.push('The password needs at least 12 characters.');
    if (password.value !== again.value) problems.push('The two passwords are different.');
    if (problems.length) {
      mount(message, notice(problems.join(' '), 'danger'));
      return;
    }
    submit.disabled = true;
    submit.classList.add('busy');
    try {
      await api.post('/api/v1/setup', { code: code.value.trim(), username: username.value.trim().toLowerCase(), password: password.value });
      await ctx.signedIn('/live');
    } catch (err) {
      mount(message, notice(err.message, 'danger'));
    } finally {
      submit.disabled = false;
      submit.classList.remove('busy');
    }
  });

  mount(view, h('div.card.auth-card', brand(), h('h1', 'Welcome'), h('p.muted', 'Create the owner account. The owner can add everyone else later, in Settings.'), form));
  code.focus();
}
