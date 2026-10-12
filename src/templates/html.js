// A template's entry document and stylesheets are third-party input, read on the server: when it
// is validated, and on every page load (the runtime is injected into it). Everything here runs in
// linear time, whatever the input: no backtracking regular expressions over the document.

// Elements whose content is text, never tags (HTML's raw text and RCDATA elements, and noscript
// with scripting on).
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript']);

// The document's start tags in order: { name, index, end, attrs } (attrs: the text between the
// name and the closing '>'). Comments, attribute values and raw text are skipped, so none of them
// can fake a tag; an unterminated tag ends the scan.
export function scanTags(html) {
  const lower = html.toLowerCase();
  const n = html.length;
  const tags = [];
  let i = 0;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt < 0) break;
    if (html.startsWith('<!--', lt)) {
      i = commentEnd(html, lt);
      continue;
    }
    if (!isLetter(html.charCodeAt(lt + 1))) {
      i = lt + 1;
      continue;
    }
    let j = lt + 1;
    while (j < n && !isTagNameEnd(html.charCodeAt(j))) j++;
    let k = j;
    let quote = 0;
    for (; k < n; k++) {
      const ch = html.charCodeAt(k);
      if (quote) { if (ch === quote) quote = 0; } else if (ch === 34 || ch === 39) quote = ch; else if (ch === 62) break;
    }
    if (k >= n) break;
    const name = lower.slice(lt + 1, j);
    const tag = { name, index: lt, end: k + 1, attrs: html.slice(j, k) };
    tags.push(tag);
    i = k + 1;
    if (RAW_TEXT.has(name)) {
      const close = lower.indexOf(`</${name}`, i);
      tag.rawEnd = close < 0 ? n : close;
      i = tag.rawEnd;
    }
  }
  return tags;
}

// Where a comment starting at `at` ends, as HTML's tokenizer sees it: at -->, --!> or the end of
// the document; <!--> and <!---> are empty comments.
function commentEnd(html, at) {
  if (html.startsWith('<!-->', at)) return at + 5;
  if (html.startsWith('<!--->', at)) return at + 6;
  for (let from = at + 4; ;) {
    const dash = html.indexOf('--', from);
    if (dash < 0) return html.length;
    if (html[dash + 2] === '>') return dash + 3;
    if (html[dash + 2] === '!' && html[dash + 3] === '>') return dash + 4;
    from = dash + 1;
  }
}

// The text inside a raw-text element (a script's code), from scanTags' tag.
export function rawText(html, tag) {
  return html.slice(tag.end, tag.rawEnd ?? tag.end);
}

// An attribute's value, or undefined (case-insensitive name; quoted or bare value).
export function attr(tag, name) {
  const s = tag.attrs;
  const lower = s.toLowerCase();
  let i = 0;
  while (i < s.length) {
    while (i < s.length && isSpaceOrSlash(s.charCodeAt(i))) i++;
    const start = i;
    while (i < s.length && !isSpaceOrSlash(s.charCodeAt(i)) && s[i] !== '=') i++;
    const key = lower.slice(start, i);
    while (i < s.length && isSpace(s.charCodeAt(i))) i++;
    let value = '';
    if (s[i] === '=') {
      i++;
      while (i < s.length && isSpace(s.charCodeAt(i))) i++;
      const q = s[i];
      if (q === '"' || q === "'") {
        const close = s.indexOf(q, i + 1);
        value = s.slice(i + 1, close < 0 ? s.length : close);
        i = close < 0 ? s.length : close + 1;
      } else {
        const v0 = i;
        while (i < s.length && !isSpace(s.charCodeAt(i))) i++;
        value = s.slice(v0, i);
      }
    }
    if (key === name) return value;
    if (i === start) i++; // a stray character: move on
  }
  return undefined;
}

// Names of a tag's attributes, lowercased.
export function attrNames(tag) {
  const names = [];
  const s = tag.attrs;
  let i = 0;
  while (i < s.length) {
    while (i < s.length && isSpaceOrSlash(s.charCodeAt(i))) i++;
    const start = i;
    while (i < s.length && !isSpaceOrSlash(s.charCodeAt(i)) && s[i] !== '=') i++;
    if (i > start) names.push(s.slice(start, i).toLowerCase());
    while (i < s.length && isSpace(s.charCodeAt(i))) i++;
    if (s[i] === '=') {
      i++;
      while (i < s.length && isSpace(s.charCodeAt(i))) i++;
      const q = s[i];
      if (q === '"' || q === "'") {
        const close = s.indexOf(q, i + 1);
        i = close < 0 ? s.length : close + 1;
      } else {
        while (i < s.length && !isSpace(s.charCodeAt(i))) i++;
      }
    }
    if (i === start) i++;
  }
  return names;
}

// CSS with its comments removed, in one pass.
export function stripCssComments(css) {
  let out = '';
  let i = 0;
  for (;;) {
    const open = css.indexOf('/*', i);
    if (open < 0) return out + css.slice(i);
    out += css.slice(i, open);
    const close = css.indexOf('*/', open + 2);
    if (close < 0) return out;
    i = close + 2;
  }
}

const isLetter = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isSpace = (c) => c === 32 || c === 9 || c === 10 || c === 12 || c === 13;
const isSpaceOrSlash = (c) => isSpace(c) || c === 47;
const isTagNameEnd = (c) => isSpaceOrSlash(c) || c === 62;
