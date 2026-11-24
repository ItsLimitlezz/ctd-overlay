// ffmpeg, when there is one (10 §10.2: optional; SKP_FFMPEG or `ffmpeg` on the PATH). Always an
// argument array, never a shell; a time limit; lowered priority, so a transcode never starves the
// overlays on air; the tail of its stderr kept for the log (07 §7.11).
import { spawn } from 'node:child_process';
import { constants, setPriority } from 'node:os';

export class FfmpegError extends Error {
  // stderr: the tail of what ffmpeg printed, when it ran and failed (the message has its last lines).
  constructor(message, code, stderr) {
    super(message);
    this.name = 'FfmpegError';
    this.code = code;
    if (stderr) this.stderr = stderr;
  }
}

// The command as [executable, ...leading args]: a configured path, or (for tests) an array.
export function ffmpegCommand(configured) {
  return Array.isArray(configured) ? configured : [configured || 'ffmpeg'];
}

// Whether an ffmpeg version reads HEIC (iPhone photos): 7.1 and later, and development builds
// ("N-…"), which are newer still.
export function readsHeic(version) {
  if (/^N-/.test(version || '')) return true;
  const m = /^n?(\d+)\.(\d+)/.exec(version || '');
  return !!m && (Number(m[1]) > 7 || (Number(m[1]) === 7 && Number(m[2]) >= 1));
}

// { available, version, heic }: whether `ffmpeg -version` runs, and what it can read. Never throws.
export function probeFfmpeg(command, opts) {
  return probeVersion(command, opts).then((info) => (info.available ? { ...info, heic: readsHeic(info.version) } : info));
}

function probeVersion(command, { timeoutMs = 10000 } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn(command[0], [...command.slice(1), '-version'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch {
      resolve({ available: false });
      return;
    }
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ available: false }); }, timeoutMs);
    child.stdout.on('data', (d) => { out = (out + d).slice(0, 4096); });
    child.on('error', () => { clearTimeout(timer); resolve({ available: false }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const version = /ffmpeg version (\S+)/.exec(out)?.[1];
      resolve(code === 0 && version ? { available: true, version } : { available: false });
    });
  });
}

// What an input holds: { video, audio, hdr, colors }, from ffmpeg's own reading of it (ffmpeg -i
// with no output lists the streams and exits 1). hdr: an HLG or PQ transfer (iPhone HDR video).
// colors: the first video stream's, as streamColors() reads them.
export async function inspect(command, input, { timeoutMs = 30000, onStart, lowerPriority } = {}) {
  let stderr = '';
  try {
    await runFfmpeg(command, ['-hide_banner', '-nostdin', '-protocol_whitelist', 'file', '-i', `file:${input}`], { timeoutMs, onStart, lowerPriority, onStderr: (s) => { stderr = s; } });
  } catch (err) {
    if (err.code !== 'failed') throw err; // exit 1 is the normal answer to "no output given"
  }
  const video = stderr.split('\n').filter((l) => /Stream #\d+:\d+.*: Video:/.test(l));
  return {
    video: video.length > 0,
    audio: /Stream #\d+:\d+.*: Audio:/.test(stderr),
    hdr: video.some((l) => /arib-std-b67|smpte2084/.test(l)),
    colors: video.length ? streamColors(video[0]) : {},
  };
}

// The colours a video stream says its pictures are in, from ffmpeg's listing of it (the same on
// ffmpeg 6, 7 and 8): "yuv420p(tv, bt709, progressive)" (all three BT.709), "yuvj420p(pc,
// bt470bg/bt470bg/smpte170m)" (matrix/primaries/transfer), or "yuv420p" (it doesn't say).
// { pixFmt, range, space (the YUV matrix), primaries, transfer }: each a name, or undefined.
const ALL_THREE = new Set(['bt709', 'smpte170m', 'smpte240m', 'bt470bg']);
export function streamColors(line) {
  const m = /Video: [^,]*, ([a-z0-9_]+)(?:\(([^)]*)\))?/.exec(line || '');
  if (!m) return {};
  const out = { pixFmt: m[1] };
  const named = (s) => (s && s !== 'unknown' && s !== 'reserved' ? s : undefined);
  for (const item of (m[2] || '').split(', ')) {
    if (item === 'tv' || item === 'pc') out.range = item;
    else if (item.includes('/')) [out.space, out.primaries, out.transfer] = item.split('/').map(named);
    else if (ALL_THREE.has(item)) out.space = out.primaries = out.transfer = item;
  }
  return out;
}

// What zscale converts from: the names it reads (zimg may still refuse an unusual pair, and the
// caller then converts without it). A colour the file doesn't name is taken as BT.709's, as
// players take it, so nothing the file doesn't say is changed.
const ZSCALE = {
  space: new Set(['gbr', 'bt709', 'fcc', 'bt470bg', 'smpte170m', 'smpte240m', 'ycgco', 'bt2020nc', 'bt2020c']),
  primaries: new Set(['bt709', 'bt470m', 'bt470bg', 'smpte170m', 'smpte240m', 'film', 'bt2020', 'smpte428', 'smpte431', 'smpte432', 'jedec-p22', 'ebu3213']),
  transfer: new Set(['bt709', 'bt470m', 'bt470bg', 'smpte170m', 'smpte240m', 'linear', 'log100', 'log316', 'bt2020-10', 'bt2020-12', 'iec61966-2-4', 'iec61966-2-1']),
};
// BT.601 and BT.2020 (SDR) use BT.709's transfer curve.
const BT709_CURVE = new Set(['bt709', 'smpte170m', 'bt2020-10', 'bt2020-12']);
const RGB = /^(rgb|bgr|gbr|argb|abgr|0rgb|0bgr|x2rgb|x2bgr)/;
function sourceColors(c = {}) {
  const rgb = RGB.test(c.pixFmt || '');
  const known = (kind) => (ZSCALE[kind].has(c[kind]) ? c[kind] : undefined);
  return {
    space: known('space') || (rgb ? 'gbr' : 'bt709'),
    primaries: known('primaries') || 'bt709',
    transfer: known('transfer') || 'bt709',
    range: c.range || (rgb || /^yuvj/.test(c.pixFmt || '') ? 'pc' : 'tv'),
  };
}

// Whether an SDR stream's pictures must be converted to be BT.709, not only tagged so: a matrix,
// primaries or transfer it names that isn't BT.709's (an older Android phone's BT.601, a P3 or
// BT.2020 SDR clip). HDR is tone-mapped instead; full range alone the scaler converts.
export function needsColorConversion(colors) {
  if (!colors || /arib-std-b67|smpte2084/.test(colors.transfer || '')) return false;
  const s = sourceColors(colors);
  return !['bt709', 'gbr'].includes(s.space) || s.primaries !== 'bt709' || !BT709_CURVE.has(s.transfer);
}

// zscale (libzimg) converting what the stream names to BT.709, limited range.
export function toBt709(colors) {
  const s = sourceColors(colors);
  return `zscale=min=${s.space}:pin=${s.primaries}:tin=${s.transfer}:rin=${s.range}:m=bt709:p=bt709:t=bt709:r=tv`;
}

// Runs one ffmpeg job. Resolves when it exits 0; rejects with FfmpegError ('failed', 'timeout',
// 'aborted' or 'missing'). abort() (returned through onStart) kills it. onStderr gets the last
// 16 KiB of what it printed. lowerPriority: false keeps normal priority (tests, whose stand-in
// must not starve on a busy machine).
export function runFfmpeg(command, args, { timeoutMs, onStart, onStderr, lowerPriority = true } = {}) {
  return new Promise((resolve, reject) => {
    let tail = '';
    let child;
    try {
      child = spawn(command[0], [...command.slice(1), ...args], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    } catch (err) {
      reject(new FfmpegError(`ffmpeg could not start (${err.code || err.message}).`, 'missing'));
      return;
    }
    let reason;
    const stop = (why) => {
      if (reason) return;
      reason = why;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    };
    try {
      // Below normal everywhere (nice 10 on POSIX): the show comes first.
      if (child.pid && lowerPriority) setPriority(child.pid, constants.priority.PRIORITY_BELOW_NORMAL);
    } catch { /* not allowed here: it runs at normal priority */ }
    const timer = timeoutMs ? setTimeout(() => stop('timeout'), timeoutMs) : null;
    onStart?.({ abort: () => stop('aborted') });
    child.stderr.on('data', (d) => { tail = (tail + d).slice(-16384); });
    child.on('error', (err) => {
      clearTimeout(timer);
      reason ??= 'missing';
      reject(new FfmpegError(`ffmpeg could not start (${err.code || err.message}).`, 'missing'));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      onStderr?.(tail);
      if (reason === 'missing') return;
      if (reason === 'timeout') reject(new FfmpegError(`ffmpeg took longer than ${Math.round(timeoutMs / 1000)} s and was stopped.`, 'timeout'));
      else if (reason === 'aborted') reject(new FfmpegError('ffmpeg was stopped (the platform is shutting down).', 'aborted'));
      else if (code === 0) resolve();
      else reject(new FfmpegError(`ffmpeg failed (${signal || `exit ${code}`}): ${tail.trim().split('\n').slice(-3).join(' ') || 'no message'}`, 'failed', tail));
    });
  });
}

// Every path goes in as file:<path>, and only the file protocol is allowed: a path is never read
// as a URL, a pipe or a pattern, whatever directory the data lives in.
const IO = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-protocol_whitelist', 'file', '-y'];

// Phone video to what OBS's browser plays (H12): 8-bit H.264 + AAC in MP4, in BT.709 (SDR,
// limited range) and tagged so, the rotation flag baked into the frames (ffmpeg rotates on
// decode), at most 1920 on the long side, even dimensions, faststart (playable before the whole
// file is read), and no metadata (a phone writes where it was filmed).
// Colours: an HDR input (iPhone 12 and later film 10-bit HLG) is tone-mapped to SDR; an SDR one
// in other colours (colors: what inspect() read) is converted; both need ffmpeg's zscale filter
// (libzimg), and zscale: false converts without it, for a build without one (only tagged then).
// RGB pictures and full range the scaler converts. The BT.709 tags go on the frames (setparams)
// as well as on the encoder: ffmpeg 7.1 and later copy the frames' colours to the encoder over
// -color_primaries and -color_trc, which on their own left a clip untagged on ffmpeg 8.
// maxBytes stops the output growing past the upload cap (ffmpeg then stops, and the caller sees
// a file over the cap).
export const TONEMAP = 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv';
export const BT709_TAGS = 'setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv';
export function videoArgs(input, output, { maxBytes, hdr = false, colors, zscale = true } = {}) {
  const to709 = 'out_color_matrix=bt709:out_range=tv';
  const fit = `scale=w='if(gt(iw,ih),min(1920,iw),-2)':h='if(gt(iw,ih),-2,min(1920,ih))':${to709},scale=trunc(iw/2)*2:trunc(ih/2)*2:${to709}`;
  const convert = !zscale ? null : hdr ? TONEMAP : needsColorConversion(colors) ? toBt709(colors) : null;
  const filters = [convert, fit, 'format=yuv420p', BT709_TAGS].filter(Boolean).join(',');
  return [
    ...IO, '-i', `file:${input}`,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-vf', filters,
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv',
    '-c:a', 'aac', '-b:a', '160k', '-ac', '2',
    '-map_metadata', '-1', '-movflags', '+faststart',
    ...(maxBytes ? ['-fs', String(maxBytes)] : []),
    `file:${output}`,
  ];
}

// A HEIC photo (what an iPhone takes) to JPEG, which every browser shows; no metadata. One image,
// written as such (-update 1), so the output name is never read as a numbered-file pattern.
export function imageArgs(input, output) {
  return [...IO, '-i', `file:${input}`, '-frames:v', '1', '-q:v', '3', '-map_metadata', '-1', '-f', 'image2', '-update', '1', `file:${output}`];
}
