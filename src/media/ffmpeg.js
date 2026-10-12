// ffmpeg, when there is one (10 §10.2: optional; SKP_FFMPEG or `ffmpeg` on the PATH). Always an
// argument array, never a shell; a time limit; lowered priority, so a transcode never starves the
// overlays on air; the tail of its stderr kept for the log (07 §7.11).
import { spawn } from 'node:child_process';
import { constants, setPriority } from 'node:os';

export class FfmpegError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'FfmpegError';
    this.code = code;
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

// What an input holds: { video, audio, hdr }, from ffmpeg's own reading of it (ffmpeg -i with no
// output lists the streams and exits 1). hdr: an HLG or PQ transfer (iPhone HDR video).
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
  };
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
      else reject(new FfmpegError(`ffmpeg failed (${signal || `exit ${code}`}): ${tail.trim().split('\n').slice(-3).join(' ') || 'no message'}`, 'failed'));
    });
  });
}

// Every path goes in as file:<path>, and only the file protocol is allowed: a path is never read
// as a URL, a pipe or a pattern, whatever directory the data lives in.
const IO = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-protocol_whitelist', 'file', '-y'];

// Phone video to what OBS's browser plays (H12): 8-bit H.264 + AAC in MP4, tagged BT.709 (SDR),
// the rotation flag baked into the frames (ffmpeg rotates on decode), at most 1920 on the long
// side, even dimensions, faststart (playable before the whole file is read), and no metadata (a
// phone writes where it was filmed). An HDR input (iPhone 12 and later film 10-bit HLG) is
// tone-mapped to SDR first; that needs ffmpeg's zscale filter (libzimg), and tonemap: false
// skips it for a build without one. maxBytes stops the output growing past the upload cap
// (ffmpeg then stops, and the caller sees a file over the cap).
export const TONEMAP = 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv';
export function videoArgs(input, output, { maxBytes, hdr = false, tonemap = true } = {}) {
  const fit = "scale=w='if(gt(iw,ih),min(1920,iw),-2)':h='if(gt(iw,ih),-2,min(1920,ih))',scale=trunc(iw/2)*2:trunc(ih/2)*2";
  const filters = [hdr && tonemap ? TONEMAP : null, fit, 'format=yuv420p'].filter(Boolean).join(',');
  return [
    ...IO, '-i', `file:${input}`,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-vf', filters,
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
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
