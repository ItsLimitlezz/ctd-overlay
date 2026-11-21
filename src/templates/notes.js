// A template release's notes, trimmed for places that show a short "what changed" (the CTD OBS
// plugin's CTD Overlays dock, through CTD Relay: connectors/summary.js).
export const NOTE_LINES = 8;
export const NOTE_LINE_CHARS = 200;

const clip = (s, n) => {
  const t = String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim(); // eslint-disable-line no-control-regex
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

// A release's notes (GitHub Markdown) as a few plain lines: headings, list marks, emphasis,
// images, HTML and link targets taken out, empty lines dropped, at most NOTE_LINES lines of
// NOTE_LINE_CHARS characters. [] for none.
export function trimNotes(markdown, { lines = NOTE_LINES, chars = NOTE_LINE_CHARS } = {}) {
  if (typeof markdown !== 'string' || !markdown) return [];
  const out = [];
  let fenced = false;
  for (let raw of String(markdown).slice(0, 20000).split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(raw)) { fenced = !fenced; continue; }
    if (fenced) continue;
    raw = raw
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // images
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links: their text
      .replace(/<[^>]+>/g, '') // HTML
      .replace(/^\s{0,3}#{1,6}\s+/, '') // headings
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, '') // list marks, checkboxes
      .replace(/^\s*>\s?/, '') // quotes
      .replace(/(\*\*|__|`)/g, '')
      .replace(/https?:\/\/\S+/g, '') // bare URLs
      .replace(/^\s*([-*_]\s*){3,}$/, ''); // rules
    const line = clip(raw, chars);
    if (!line || /^full changelog:?$/i.test(line)) continue;
    out.push(line);
    if (out.length >= lines) break;
  }
  return out;
}

