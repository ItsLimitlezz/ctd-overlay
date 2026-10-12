// What an uploaded file is, from its first bytes: never from its name or what the uploader says
// (07 §7.11). Only types an overlay can show, play or use are accepted:
//
//   image  PNG, JPEG, GIF, WebP, AVIF; HEIC (iPhone photos), which is converted to JPEG
//   video  MP4, QuickTime, Matroska, AVI (converted to H.264 MP4, H12); WebM (kept: VP8/VP9
//          play in OBS's browser, and a stinger's alpha channel would not survive H.264)
//   audio  MP3, AAC (M4A), Ogg, FLAC, WAV
//   font   WOFF2, WOFF, TrueType, OpenType
//
// SVG is not accepted: it is a document that can carry script, and telling it from other XML by
// its first bytes is guesswork.
export const SNIFF_BYTES = 4096;

const ascii = (buf, at, len) => buf.toString('latin1', at, at + len);

// ISO base media (MP4 and relatives) by the major brand in its ftyp box.
const HEIF = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1']);
const AVIF = new Set(['avif', 'avis']);
const M4A = new Set(['M4A ', 'M4B ', 'M4P ', 'F4A ', 'F4B ']);

// { type, kind, ext, convert? } or undefined. convert: 'video' (to H.264 MP4) or 'image' (to JPEG).
export function sniff(head) {
  if (!head || head.length < 4) return undefined;
  const b = head;
  if (b.length >= 8 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a) return image('image/png', 'png');
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return image('image/jpeg', 'jpg');
  if (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a') return image('image/gif', 'gif');
  if (ascii(b, 0, 4) === 'RIFF' && b.length >= 12) {
    const form = ascii(b, 8, 4);
    if (form === 'WEBP') return image('image/webp', 'webp');
    if (form === 'WAVE') return { type: 'audio/wav', kind: 'audio', ext: 'wav' };
    if (form === 'AVI ') return { type: 'video/x-msvideo', kind: 'video', ext: 'avi', convert: 'video' };
    return undefined;
  }
  if (b.length >= 12 && ascii(b, 4, 4) === 'ftyp') {
    const brand = ascii(b, 8, 4);
    if (AVIF.has(brand)) return image('image/avif', 'avif');
    if (HEIF.has(brand)) return { type: 'image/heic', kind: 'image', ext: 'heic', convert: 'image' };
    if (M4A.has(brand)) return { type: 'audio/mp4', kind: 'audio', ext: 'm4a' };
    if (brand === 'qt  ') return { type: 'video/quicktime', kind: 'video', ext: 'mov', convert: 'video' };
    return { type: 'video/mp4', kind: 'video', ext: 'mp4', convert: 'video' };
  }
  if (b.readUInt32BE(0) === 0x1a45dfa3) {
    // EBML: the DocType element (0x4282) says webm or matroska, within the first bytes.
    const doc = b.indexOf(Buffer.from([0x42, 0x82]));
    const isWebm = doc > 0 && b.indexOf('webm', doc, 'latin1') > 0 && b.indexOf('webm', doc, 'latin1') < doc + 12;
    return isWebm ? { type: 'video/webm', kind: 'video', ext: 'webm' } : { type: 'video/x-matroska', kind: 'video', ext: 'mkv', convert: 'video' };
  }
  if (ascii(b, 0, 4) === 'OggS') return { type: 'audio/ogg', kind: 'audio', ext: 'ogg' };
  if (ascii(b, 0, 4) === 'fLaC') return { type: 'audio/flac', kind: 'audio', ext: 'flac' };
  if (ascii(b, 0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0 && (b[1] & 0x06) !== 0)) return { type: 'audio/mpeg', kind: 'audio', ext: 'mp3' };
  if (ascii(b, 0, 4) === 'wOF2') return font('font/woff2', 'woff2');
  if (ascii(b, 0, 4) === 'wOFF') return font('font/woff', 'woff');
  if (ascii(b, 0, 4) === 'OTTO') return font('font/otf', 'otf');
  if (b.readUInt32BE(0) === 0x00010000 || ascii(b, 0, 4) === 'true') return font('font/ttf', 'ttf');
  return undefined;
}

function image(type, ext) {
  return { type, kind: 'image', ext };
}

function font(type, ext) {
  return { type, kind: 'font', ext };
}
