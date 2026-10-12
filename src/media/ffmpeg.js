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

// { available, version }: whether `ffmpeg -version` runs. Never throws.
export function probeFfmpeg(command, { timeoutMs = 10000 } = {}) {
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

// Runs one ffmpeg job. Resolves when it exits 0; rejects with FfmpegError ('failed', 'timeout',
// 'aborted' or 'missing'). abort() (returned through onStart) kills it.
export function runFfmpeg(command, args, { timeoutMs, onStart } = {}) {
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
      if (child.pid) setPriority(child.pid, constants.priority.PRIORITY_BELOW_NORMAL);
    } catch { /* not allowed here: it runs at normal priority */ }
    const timer = timeoutMs ? setTimeout(() => stop('timeout'), timeoutMs) : null;
    onStart?.({ abort: () => stop('aborted') });
    child.stderr.on('data', (d) => { tail = (tail + d).slice(-2000); });
    child.on('error', (err) => {
      clearTimeout(timer);
      reason ??= 'missing';
      reject(new FfmpegError(`ffmpeg could not start (${err.code || err.message}).`, 'missing'));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (reason === 'missing') return;
      if (reason === 'timeout') reject(new FfmpegError(`ffmpeg took longer than ${Math.round(timeoutMs / 1000)} s and was stopped.`, 'timeout'));
      else if (reason === 'aborted') reject(new FfmpegError('ffmpeg was stopped (the platform is shutting down).', 'aborted'));
      else if (code === 0) resolve();
      else reject(new FfmpegError(`ffmpeg failed (${signal || `exit ${code}`}): ${tail.trim().split('\n').slice(-3).join(' ') || 'no message'}`, 'failed'));
    });
  });
}

// Phone video to what OBS's browser plays (H12): H.264 + AAC in MP4, the rotation flag baked into
// the frames (ffmpeg rotates on decode), at most 1920 on the long side, even dimensions,
// faststart (playable before the whole file is read), and no metadata (a phone writes where it
// was filmed).
export function videoArgs(input, output) {
  const fit = "scale=w='if(gt(iw,ih),min(1920,iw),-2)':h='if(gt(iw,ih),-2,min(1920,ih))',scale=trunc(iw/2)*2:trunc(ih/2)*2";
  return [
    '-hide_banner', '-nostdin', '-loglevel', 'error', '-y', '-i', input,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-vf', fit,
    '-c:a', 'aac', '-b:a', '160k', '-ac', '2',
    '-map_metadata', '-1', '-movflags', '+faststart',
    output,
  ];
}

// A HEIC photo (what an iPhone takes) to JPEG, which every browser shows; no metadata.
export function imageArgs(input, output) {
  return ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', '-i', input, '-frames:v', '1', '-q:v', '3', '-map_metadata', '-1', output];
}
