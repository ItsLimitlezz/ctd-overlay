// Who owns a value or an event on the bus (01 §1.2–1.3): the core (''), a connection (its id), or
// one feed of a connection, a profile it follows at its service (CTD Relay's, 06 §6.11):
// "<connection id>/<profile id>". A connection's own data and its feeds' data are its data: what
// acts on a connection (stopping it, deleting it, holding its values through an error, ranking it
// as a relay) acts on its feeds too. Bindings name owners the same way: a connection id (every
// feed of it, made later too) or "<connection id>/<profile id>" (that feed only).

// The owner of what src says: its connection, and the profile in it when it names one.
export const ownerOf = (src) => {
  const conn = src && typeof src.connection === 'string' ? src.connection : '';
  if (!conn) return '';
  return typeof src.profile === 'string' && src.profile ? `${conn}/${src.profile}` : conn;
};

// "<connection id>/<profile id>" for a feed, the connection id alone without a profile.
export const feedKey = (conn, profile) => (profile ? `${conn}/${profile}` : conn);

// The connection an owner (or a binding) belongs to: the part before the first "/".
export const connectionOf = (owner) => {
  const s = String(owner ?? '');
  const i = s.indexOf('/');
  return i < 0 ? s : s.slice(0, i);
};

// The profile a feed owner (or binding) names, or undefined for a whole connection.
export const profileOf = (owner) => {
  const s = String(owner ?? '');
  const i = s.indexOf('/');
  return i < 0 ? undefined : s.slice(i + 1);
};

// Whether owner is the connection connId itself or one of its feeds.
export const isOfConnection = (owner, connId) => Boolean(connId) && (owner === connId || (typeof owner === 'string' && owner.startsWith(`${connId}/`)));

// Whether bindings (a list of connection ids and "<connection>/<profile>" entries) let an owner's
// data through: its connection named whole, or its own feed named.
export const listAllows = (list, owner) => {
  if (!owner) return true;
  const has = list instanceof Set ? (x) => list.has(x) : (x) => list.includes(x);
  return has(owner) || (owner.includes('/') && has(connectionOf(owner)));
};
