// JSON-file backend for very small installs (10 §10.2). The whole store is one file, rewritten
// atomically on every committed change (10 §10.6). Maps in memory, so IDs like "__proto__"
// are just IDs.
import { existsSync, readFileSync } from 'node:fs';
import { atomicWriteFileSync, moveAside } from '../fsutil.js';

const FORMAT = 'skp-store';
const VERSION = 1;

export function openJsonBackend(file, { log }) {
  let movedAside = null;
  let state = { meta: new Map(), collections: new Map() };

  if (existsSync(file)) {
    const text = readFileSync(file, 'utf8'); // I/O errors propagate: an unreadable file isn't a corrupt one
    try {
      state = parse(text);
    } catch (err) {
      movedAside = moveAside(file);
      log.error('the store file could not be read, so it was moved aside and an empty one created', { file, movedAside, err });
    }
  }

  const primsFor = (s, onChange = () => {}) => ({
    read(collection, id) {
      const doc = s.collections.get(collection)?.get(id);
      return doc ? { rev: doc.rev, data: structuredClone(doc.data) } : undefined;
    },
    write(collection, id, rev, json) {
      if (!s.collections.has(collection)) s.collections.set(collection, new Map());
      s.collections.get(collection).set(id, { rev, data: JSON.parse(json) });
      onChange();
    },
    remove(collection, id) {
      if (s.collections.get(collection)?.delete(id)) onChange();
    },
    scan(collection, { after, prefix, limit }) {
      const docs = s.collections.get(collection);
      if (!docs) return [];
      return [...docs.keys()]
        .filter((id) => id > after && id.startsWith(prefix))
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
        .slice(0, limit)
        .map((id) => ({ id, rev: docs.get(id).rev, data: structuredClone(docs.get(id).data) }));
    },
    getMeta(key) { return s.meta.get(key); },
    setMeta(key, value) { s.meta.set(key, String(value)); onChange(); },
  });

  return {
    kind: 'json',
    file,
    movedAside,
    get prims() { return primsFor(state); },
    // Runs fn against a copy; only a successful run is written to disk and swapped in, so a
    // throw (or a failed write) leaves both the file and memory as they were.
    atomic(fn) {
      const draft = structuredClone(state);
      let dirty = false;
      const result = fn(primsFor(draft, () => { dirty = true; }));
      if (dirty) atomicWriteFileSync(file, serialize(draft));
      state = draft;
      return result;
    },
    backup(dest) { atomicWriteFileSync(dest, serialize(state)); },
    close() {},
  };
}

function serialize(s) {
  const collections = {};
  for (const [name, docs] of s.collections) collections[name] = Object.fromEntries(docs);
  return JSON.stringify({ format: FORMAT, version: VERSION, meta: Object.fromEntries(s.meta), collections });
}

function parse(text) {
  const raw = JSON.parse(text);
  if (!raw || raw.format !== FORMAT || raw.version !== VERSION || typeof raw.meta !== 'object' || typeof raw.collections !== 'object') {
    throw new Error(`not a ${FORMAT} v${VERSION} file`);
  }
  const collections = new Map();
  for (const [name, docs] of Object.entries(raw.collections)) {
    const map = new Map();
    for (const [id, doc] of Object.entries(docs)) {
      if (!doc || !Number.isInteger(doc.rev) || !('data' in doc)) throw new Error(`bad document ${name}/${id}`);
      map.set(id, { rev: doc.rev, data: doc.data });
    }
    collections.set(name, map);
  }
  return { meta: new Map(Object.entries(raw.meta).map(([k, v]) => [k, String(v)])), collections };
}
