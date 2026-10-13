// Writes envelopes to one Server-Sent Events response (01 §1.5). Every message carries `id:`
// (the cursor) and `event:` (the envelope type); `data:` is the whole envelope as JSON.
//
// A slow client builds a queue while the socket is backed up. Past 1000 envelopes the oldest
// chat.message is dropped first and the count rides on the next envelope as meta.chatDropped
// (02 §2.9). If nothing droppable is left, the stream is ended instead: the client reconnects
// from its cursor and replays, or re-fetches the snapshot, either of which beats a silent gap.
export const MAX_QUEUE = 1000;

export function frame(env) {
  return `id: ${env.id}\nevent: ${env.type}\ndata: ${JSON.stringify(env)}\n\n`;
}

export function createSseWriter(res, { maxQueue = MAX_QUEUE, onOverflow = () => res.end() } = {}) {
  const queue = [];
  let blocked = false;
  let chatDropped = 0;
  let closed = false;

  function flush() {
    while (queue.length && !blocked && !closed) {
      let env = queue.shift();
      if (chatDropped) {
        env = { ...env, meta: { ...env.meta, chatDropped } };
        chatDropped = 0;
      }
      if (!res.write(frame(env))) {
        blocked = true;
        res.once('drain', () => { blocked = false; flush(); });
      }
    }
  }

  return {
    send(env) {
      if (closed) return;
      queue.push(env);
      if (queue.length > maxQueue) {
        const i = queue.findIndex((e) => e.type === 'chat.message');
        if (i >= 0) {
          queue.splice(i, 1);
          chatDropped++;
        } else {
          closed = true;
          queue.length = 0;
          onOverflow();
          return;
        }
      }
      flush();
    },
    // A comment line: the heartbeat that keeps idle proxies from cutting the connection.
    comment(text) {
      if (!closed && !blocked) res.write(`: ${text}\n\n`);
    },
    close() { closed = true; queue.length = 0; },
    get queued() { return queue.length; },
  };
}
