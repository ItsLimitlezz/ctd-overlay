// A stand-in for ffmpeg in tests: `node fake-ffmpeg.mjs <ffmpeg args>`. What it does is chosen by
// FAKE_FFMPEG: copy (the default: the input becomes the output), fail, partial (half an output,
// then fails), empty (exits 0 having written nothing), grow (an output over its -fs cap),
// nozscale (a build without the zscale filter: a tone-mapping run fails, others copy), hang.
// FAKE_FFMPEG_DELAY waits first (ms); FAKE_FFMPEG_LOG gets one JSON line per run ({ pid, start,
// end, args }); FAKE_FFMPEG_VERSION is what -version reports; FAKE_FFMPEG_STREAMS is what
// `-i <file>` with no output lists (as ffmpeg prints it): video and audio unless set.
import { appendFileSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { getPriority } from 'node:os';

const args = process.argv.slice(2);
if (args.includes('-version')) {
  process.stdout.write(`ffmpeg version ${process.env.FAKE_FFMPEG_VERSION || '7.1-fake'} Copyright (c) the test suite\n`);
  // FAKE_FFMPEG_VERSION_EXIT: a broken install that prints a version and fails anyway.
  process.exit(Number(process.env.FAKE_FFMPEG_VERSION_EXIT || 0));
}
const mode = process.env.FAKE_FFMPEG || 'copy';
const delay = Number(process.env.FAKE_FFMPEG_DELAY || 0);
// ffmpeg is given file:<path> (src/media/ffmpeg.js).
const unfile = (p) => (p && p.startsWith('file:') ? p.slice(5) : p);
const input = unfile(args[args.indexOf('-i') + 1]);
const output = unfile(args[args.length - 1]);
const start = Date.now();
const record = (extra) => {
  if (process.env.FAKE_FFMPEG_LOG) appendFileSync(process.env.FAKE_FFMPEG_LOG, `${JSON.stringify({ pid: process.pid, priority: getPriority(), start, end: Date.now(), args, ...extra })}\n`);
};

// ffmpeg -i <file> with no output: list the streams, and exit 1 as ffmpeg does.
if (args.indexOf('-i') === args.length - 2) {
  record({ inspect: true });
  process.stderr.write(`Input #0, mov,mp4,m4a,3gp,3g2,mj2, from '${input}':\n`);
  process.stderr.write(process.env.FAKE_FFMPEG_STREAMS ?? '  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(tv, bt709), 1920x1080, 30 fps\n  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp\n');
  process.stderr.write('At least one output file must be specified\n');
  process.exit(1);
}

if (mode === 'hang') {
  record({ hang: true });
  setInterval(() => {}, 60000);
} else {
  setTimeout(() => {
    const tonemaps = args.some((a) => a.includes('zscale'));
    if (mode === 'nozscale' && tonemaps) {
      record({ mode });
      process.stderr.write("[AVFilterGraph @ 0x1] No such filter: 'zscale'\nError initializing complex filters.\n");
      process.exit(1);
    }
    if (mode === 'copy' || mode === 'nozscale') copyFileSync(input, output);
    if (mode === 'partial') writeFileSync(output, readFileSync(input).subarray(0, 8));
    // grow: an output larger than the -fs cap it was given (as when ffmpeg stops at the cap, just over it).
    if (mode === 'grow') writeFileSync(output, Buffer.alloc(Number(args[args.indexOf('-fs') + 1]) + 100, 1));
    record({ mode });
    if (mode === 'fail' || mode === 'partial') {
      process.stderr.write(`${input}: Invalid data found when processing input\n`);
      process.exit(1);
    }
    process.exit(0);
  }, delay);
}
