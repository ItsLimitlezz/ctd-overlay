// The store: JSON documents in named collections, each with a revision number that goes up by one
// on every write. Revisions are what ETag / If-Match will be built on (03 §3.1, H16): a write can
// say which revision it expects, and gets a ConflictError instead of overwriting newer work.
// Everything is synchronous; transaction() runs a function atomically.
import path from 'node:path';
import { openJsonBackend } from './jsonfile.js';
import { openSqliteBackend } from './sqlite.js';

export class ConflictError extends Error {
  constructor(collection, id, currentRev, expectedRev) {
    super(expectedRev === 0
      ? `${collection}/${id} already exists (revision ${currentRev})`
      : `${collection}/${id} is at revision ${currentRev}, not ${expectedRev}`);
    this.name = 'ConflictError';
    this.code = 'conflict';
    this.collection = collection;
    this.id = id;
    this.currentRev = currentRev;
    this.expectedRev = expectedRev;
  }
}

const COLLECTION = /^[a-z][a-z0-9_]{0,63}$/;
const ID = /^[\x21-\x7e]{1,256}$/; // printable ASCII, so SQLite and JavaScript sort IDs the same way
const MAX_LIST = 1000;

export function openStore({ dataDir, backend = 'sqlite', log }) {
  const impl = backend === 'json'
    ? openJsonBackend(path.join(dataDir, 'skp.json'), { log })
    : openSqliteBackend(path.join(dataDir, 'skp.db'), { log });
  return new Store(impl);
}

export class Store {
  #impl;
  #inTx = false;
  #closed = false;

  constructor(impl) { this.#impl = impl; }

  get kind() { return this.#impl.kind; }
  get file() { return this.#impl.file; }
  // Set when a corrupt file was found at startup and moved here (10 §10.6).
  get movedAside() { return this.#impl.movedAside; }

  get schemaVersion() {
    this.#check();
    return Number(this.#impl.prims.getMeta('schemaVersion') ?? 0);
  }

  get(collection, id) { this.#check(); return getIn(this.#impl.prims, collection, id); }
  list(collection, opts) { this.#check(); return listIn(this.#impl.prims, collection, opts); }
  put(collection, id, data, opts) { this.#check(); return this.#impl.atomic((p) => putIn(p, collection, id, data, opts)); }
  delete(collection, id, opts) { this.#check(); return this.#impl.atomic((p) => deleteIn(p, collection, id, opts)); }

  // fn receives a transaction object with get/list/put/delete. It must be synchronous; if it
  // throws, nothing it wrote is kept.
  transaction(fn) {
    this.#check();
    this.#inTx = true;
    let tx;
    try {
      return this.#impl.atomic((p) => {
        tx = txApi(p);
        const result = fn(tx);
        if (result && typeof result.then === 'function') throw new TypeError('transaction() callbacks must be synchronous');
        return result;
      });
    } finally {
      if (tx) tx.done = true;
      this.#inTx = false;
    }
  }

  backup(dest) { this.#check(); this.#impl.backup(dest); }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#impl.close();
  }

  #check() {
    if (this.#closed) throw new Error('the store is closed');
    if (this.#inTx) throw new Error('inside transaction(), use the transaction object it passes in');
  }
}

function txApi(p) {
  const tx = {
    done: false,
    get: (c, id) => guard(tx) && getIn(p, c, id),
    list: (c, opts) => guard(tx) && listIn(p, c, opts),
    put: (c, id, data, opts) => guard(tx) && putIn(p, c, id, data, opts),
    delete: (c, id, opts) => guard(tx) && deleteIn(p, c, id, opts),
    getMeta: (key) => guard(tx) && p.getMeta(key),
    setMeta: (key, value) => guard(tx) && p.setMeta(key, value),
  };
  return tx;
}

function guard(tx) {
  if (tx.done) throw new Error('this transaction has already finished');
  return true;
}

function check(collection, id) {
  if (typeof collection !== 'string' || !COLLECTION.test(collection)) {
    throw new TypeError(`bad collection name ${JSON.stringify(collection)}: use lowercase letters, digits and _`);
  }
  if (id !== undefined && (typeof id !== 'string' || !ID.test(id))) {
    throw new TypeError(`bad id ${JSON.stringify(id)}: use 1 to 256 printable ASCII characters, no spaces`);
  }
}

function checkRev(ifRev) {
  if (ifRev !== undefined && !(Number.isInteger(ifRev) && ifRev >= 0)) {
    throw new TypeError(`ifRev must be a whole number of 0 or more (got ${JSON.stringify(ifRev)})`);
  }
}

function getIn(p, collection, id) {
  check(collection, id);
  const doc = p.read(collection, id);
  return doc ? { id, rev: doc.rev, data: doc.data } : undefined;
}

function listIn(p, collection, { after = '', prefix = '', limit = 100 } = {}) {
  check(collection);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST) throw new TypeError(`limit must be 1 to ${MAX_LIST}`);
  return p.scan(collection, { after: String(after), prefix: String(prefix), limit });
}

// ifRev: undefined = write regardless; 0 = create only; n = only if the current revision is n.
function putIn(p, collection, id, data, { ifRev } = {}) {
  check(collection, id);
  checkRev(ifRev);
  let json;
  try { json = JSON.stringify(data); } catch (err) { throw new TypeError(`data must be JSON-serializable: ${err.message}`); }
  if (json === undefined) throw new TypeError('data must be a JSON value');
  const current = p.read(collection, id);
  const currentRev = current ? current.rev : 0;
  if (ifRev !== undefined && ifRev !== currentRev) throw new ConflictError(collection, id, currentRev, ifRev);
  const rev = currentRev + 1;
  p.write(collection, id, rev, json);
  return { id, rev, data: JSON.parse(json) };
}

function deleteIn(p, collection, id, { ifRev } = {}) {
  check(collection, id);
  checkRev(ifRev);
  const current = p.read(collection, id);
  const currentRev = current ? current.rev : 0;
  if (ifRev !== undefined && ifRev !== currentRev) throw new ConflictError(collection, id, currentRev, ifRev);
  if (!current) return false;
  p.remove(collection, id);
  return true;
}
