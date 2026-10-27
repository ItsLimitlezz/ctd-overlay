// A time of day typed as text, the same in every browser. Safari's <input type="time"> shows a
// placeholder AM/PM that looks set but isn't: until that part is picked its value is empty, so a
// lineup typed there looked filled in and was refused as having no time. This one reads what
// people type ("9pm", "9:30 PM", "21:30", "2130", "21h30") and says what's wrong.
//
// timeInput({ value: "21:30", required, disabled, oninput, onchange, seconds, inline, … }) is an
// <input> whose value reads:
//   "HH:MM" (24 h; "HH:MM:SS" when seconds were typed and `seconds` allows them) for a time,
//   ""      when it is empty,
//   "?…"    the text as typed, marked, when it can't be read: never time-shaped, so a page's own
//           check (/^([01]\d|2[0-3]):[0-5]\d$/) refuses it, and a redraw that sets it back keeps it
//           as typed (and still wrong) instead of reading "10:30" as morning.
// Setting value takes "HH:MM" (or "HH:MM:SS") and shows it as this browser writes times
// ("9:30 PM", or "21:30"); "?…" puts the text back as typed. What's wrong is said under the box
// once it is left (inline: false when the page says it itself; timeError(value) gives the words),
// and by the form that is sent with it, in the same words (timeProblem(value, what)), never in
// others: a form never asks for "22:30" on a phone whose box says "Add AM or PM".
import { h } from './dom.js';

const VALUE = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;
let ids = 0;

// Whether this browser writes times on a 12-hour clock (with AM/PM).
export function twelveHour(locale) {
  try {
    const o = new Intl.DateTimeFormat(locale, { hour: 'numeric' }).resolvedOptions();
    return o.hourCycle ? o.hourCycle === 'h12' || o.hourCycle === 'h11' : o.hour12 === true;
  } catch {
    return false;
  }
}

// "HH:MM" (or "HH:MM:SS") as shown: "9:30 PM" on a 12-hour clock, "21:30" otherwise; "" else.
export function formatTime(value, { h12 = false } = {}) {
  const m = VALUE.exec(value || '');
  if (!m) return '';
  const hour = Number(m[1]);
  const rest = `${m[2]}${m[3] ? `:${m[3]}` : ''}`;
  if (!h12) return `${m[1]}:${rest}`;
  return `${hour % 12 || 12}:${rest} ${hour < 12 ? 'AM' : 'PM'}`;
}

// What was typed, read: { value: "HH:MM" }, { empty: true }, or { error } in plain words. On a
// 12-hour clock "9:30" (or "1030") without AM or PM is a question, not a guess: a set at 10:30 is
// rarely in the morning, but an after-hours one might be. An hour written with a leading zero
// ("09:30", "0930"), 0, or past 12 ("21:30") is 24-hour time.
export function parseTime(text, { h12 = false, seconds = false } = {}) {
  const raw = String(text ?? '').trim();
  if (!raw) return { empty: true };
  const like = h12 ? '9:30 PM' : '21:30';
  const s = raw.toLowerCase().replace(/\s+/g, '').replace(/\./g, '').replace(/^(\d{1,2})h(\d{2})?$/, (_, a, b) => `${a}:${b || '00'}`);
  // "930" is 9:30, "2130" 21:30; seconds only after a colon.
  const m = /^(\d{1,2})(?::?([0-5]\d))?(?::([0-5]\d))?(am|pm|a|p)?$/.exec(s);
  if (!m) return { error: `"${raw}" isn't a time. Type it like ${like}.` };
  if (m[3] !== undefined && (!seconds || m[2] === undefined)) return { error: `Type the time without seconds, like ${like}.` };
  let hour = Number(m[1]);
  const minute = Number(m[2] || 0);
  const meridiem = m[4]?.[0];
  const mm = String(minute).padStart(2, '0');
  if (meridiem) {
    if (hour < 1 || hour > 12) return { error: `With AM or PM the hour is 1 to 12: "${raw}".` };
    hour = (hour % 12) + (meridiem === 'p' ? 12 : 0);
  } else {
    if (hour > 23) return { error: `There's no hour ${hour}: type it like ${like}.` };
    const twentyFour = /^0\d/.test(s) || hour === 0 || hour > 12;
    if (h12 && !twentyFour) return { error: `Add AM or PM: ${hour}:${mm} PM, or ${hour}:${mm} AM.` };
  }
  return { value: `${String(hour).padStart(2, '0')}:${mm}${m[3] !== undefined ? `:${m[3]}` : ''}` };
}

// The words for a value a timeInput gave that isn't a time ("?…"), or undefined.
export function timeError(value, { h12 = twelveHour(), seconds = false } = {}) {
  return typeof value === 'string' && value.startsWith('?') ? parseTime(value.slice(1), { h12, seconds }).error : undefined;
}

// What's wrong with a timeInput's value when its form is sent, naming the box (what): the box's
// own words for one that can't be read ("The go-live time: add AM or PM: 10:30 PM, or 10:30 AM."),
// `missing` for an empty one that needs a time. undefined: it can be sent.
export function timeProblem(value, what, { missing, h12 = twelveHour(), seconds = false } = {}) {
  if (typeof value === 'string' && VALUE.test(value)) return undefined;
  if (!value) return missing;
  const words = timeError(value, { h12, seconds }) || `Type it like ${formatTime('21:30', { h12 })}.`;
  return `${what}: ${words[0].toLowerCase()}${words.slice(1)}`;
}

export function timeInput({ value, h12 = twelveHour(), seconds = false, inline = true, ...attrs } = {}) {
  const input = h('input', {
    type: 'text',
    inputmode: 'text',
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
    maxlength: '16',
    placeholder: h12 ? '9:30 PM' : '21:30',
    ...attrs,
    class: ['time-field', attrs.class].filter(Boolean).join(' '),
  });
  const native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  const text = () => native.get.call(input);
  const read = () => parseTime(text(), { h12, seconds });
  const message = inline ? h('span.small.time-error', { id: `time-error-${++ids}`, role: 'status', hidden: true }) : null;
  // What's wrong, said (show) or only kept for when it is: the box is red and the words under it
  // once it has been left, and they go as soon as it's right.
  let said = false;
  const check = (show) => {
    const r = read();
    input.setCustomValidity(r.error || '');
    if (show) said = Boolean(r.error);
    else if (!r.error) said = false;
    if (said) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
    if (message) {
      if (said && !message.isConnected && input.isConnected) input.after(message);
      message.textContent = said ? r.error : '';
      message.hidden = !said;
      const by = (input.getAttribute('aria-describedby') || '').split(/\s+/).filter((x) => x && x !== message.id);
      if (said) by.push(message.id);
      if (by.length) input.setAttribute('aria-describedby', by.join(' '));
      else input.removeAttribute('aria-describedby');
    }
    return r;
  };
  Object.defineProperty(input, 'value', {
    configurable: true,
    get() {
      const r = read();
      return r.value ?? (r.empty ? '' : `?${text().trim()}`);
    },
    set(v) {
      const s = String(v ?? '');
      native.set.call(input, s.startsWith('?') ? s.slice(1) : VALUE.test(s) ? formatTime(s, { h12 }) : s);
      check(s.startsWith('?'));
    },
  });
  input.addEventListener('input', () => check(false));
  // Leaving the box: a time is written out in full ("9pm" → "9:00 PM"), a problem is said.
  input.addEventListener('change', () => {
    const r = check(true);
    if (r.value) native.set.call(input, formatTime(r.value, { h12 }));
  });
  if (value !== undefined) input.value = value;
  return input;
}
