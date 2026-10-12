// A stand-in for ffmpeg in tests: `node fake-ffmpeg.mjs <ffmpeg args>`. What it does is chosen by
// FAKE_FFMPEG: copy (the default: the input becomes the output), fail, partial (half an output,
// then fails), empty (exits 0 having written nothing), hang. FAKE_FFMPEG_DELAY waits first (ms);
// FAKE_FFMPEG_LOG gets one JSON line per run ({ pid, start, end, args }).
import { appendFileSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (args.includes('-version')) {
  process.stdout.write('ffmpeg version 7.1-fake Copyright (c) the test suite\n');
  process.exit(0);
}
const mode = process.env.FAKE_FFMPEG || 'copy';
const delay = Number(process.env.FAKE_FFMPEG_DELAY || 0);
const input = args[args.indexOf('-i') + 1];
const output = args[args.length - 1];
const start = Date.now();
const record = (extra) => {
  if (process.env.FAKE_FFMPEG_LOG) appendFileSync(process.env.FAKE_FFMPEG_LOG, `${JSON.stringify({ pid: process.pid, start, end: Date.now(), args, ...extra })}\n`);
};

if (mode === 'hang') {
  record({ hang: true });
  setInterval(() => {}, 60000);
} else {
  setTimeout(() => {
    if (mode === 'copy') copyFileSync(input, output);
    if (mode === 'partial') writeFileSync(output, readFileSync(input).subarray(0, 8));
    record({ mode });
    if (mode === 'fail' || mode === 'partial') {
      process.stderr.write(`${input}: Invalid data found when processing input\n`);
      process.exit(1);
    }
    process.exit(0);
  }, delay);
}
