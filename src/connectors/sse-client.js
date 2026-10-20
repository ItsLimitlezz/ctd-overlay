// Reads Server-Sent Events (the WHATWG event-stream format) from a response body, for connectors
// that follow another service's live feed (CTD Relay, step 16b). Frames are separated by a
// blank line; `id:`, `event:`, `data:` (several lines join with "\n") and `retry:` are kept, a line
// starting with ":" is a comment (a heartbeat). A frame larger than maxFrameBytes is refused (the
// stream is broken or hostile), never buffered without bound.
//
//   await readSse(body, (frame) => …, { onActivity, onComment, maxFrameBytes })
//   frame: { id?, event (default "message"), data, retry? }
// Resolves when the stream ends; rejects when it errors or a frame is too large. onFrame may be
// async: frames are handled one after the other.
export const MAX_FRAME_BYTES = 256 * 1024;

export async function readSse(body, onFrame, { onActivity = () => {}, onComment = () => {}, maxFrameBytes = MAX_FRAME_BYTES } = {}) {
  if (!body) throw new TypeError('no response body to read events from');
  const decoder = new TextDecoder();
  let buf = '';
  let frame = { data: [] };
  const finish = async () => {
    const f = frame;
    frame = { data: [] };
    if (!f.data.length && f.id === undefined && f.event === undefined) return;
    const out = { event: f.event || 'message', data: f.data.join('\n') };
    if (f.id !== undefined) out.id = f.id;
    if (f.retry !== undefined) out.retry = f.retry;
    if (!f.data.length) return; // an event with no data is not dispatched (the id still counts)
    await onFrame(out);
  };
  const line = async (l) => {
    if (l === '') return finish();
    if (l.startsWith(':')) return onComment(); // a comment: a heartbeat
    const i = l.indexOf(':');
    const field = i < 0 ? l : l.slice(0, i);
    let value = i < 0 ? '' : l.slice(i + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') frame.data.push(value);
    else if (field === 'event') frame.event = value;
    else if (field === 'id' && !value.includes('\0')) frame.id = value;
    else if (field === 'retry' && /^\d+$/.test(value)) frame.retry = Number(value);
    return undefined;
  };
  const chunks = body[Symbol.asyncIterator] ? body : streamIterator(body);
  for await (const chunk of chunks) {
    onActivity();
    buf += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    for (;;) {
      const m = /\r\n|\r|\n/.exec(buf);
      if (!m) break;
      const l = buf.slice(0, m.index);
      // A lone \r at the end may be the first half of \r\n: wait for the next chunk.
      if (m[0] === '\r' && m.index === buf.length - 1) break;
      buf = buf.slice(m.index + m[0].length);
      await line(l);
    }
    const pending = Buffer.byteLength(buf) + frame.data.reduce((n, d) => n + d.length, 0);
    if (pending > maxFrameBytes) throw Object.assign(new Error(`an event over ${Math.round(maxFrameBytes / 1024)} KiB arrived; the stream is broken`), { code: 'frame-too-large' });
  }
  buf += decoder.decode();
  if (buf) await line(buf);
  await finish();
}

async function* streamIterator(stream) {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.releaseLock?.();
  }
}
