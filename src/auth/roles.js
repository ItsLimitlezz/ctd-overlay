// Roles and scopes (07 §7.5, 03 §3.3). A role is a set of scopes; an API token holds some of its
// creator's, and never more than the creator's role has at the time it is used.
export const SCOPES = Object.freeze([
  'overlays:read', 'overlays:write', 'overlays:control',
  'templates:read', 'templates:write',
  'connections:read', 'connections:write',
  'timeline:read', 'timeline:write',
  'events:read', 'events:publish', 'state:write',
  'media:write', 'audit:read', 'users:admin', 'system:admin',
]);

const VIEWER = ['overlays:read', 'templates:read', 'timeline:read', 'events:read'];
// Who runs the show on the night: everything live, nothing about credentials (07 §7.5).
const OPERATOR = [...VIEWER, 'overlays:write', 'overlays:control', 'timeline:write', 'events:publish', 'state:write'];
const ADMIN = [...OPERATOR, 'templates:write', 'media:write', 'connections:read', 'connections:write', 'audit:read'];
const OWNER = [...ADMIN, 'users:admin', 'system:admin'];

export const ROLES = Object.freeze({
  owner: Object.freeze(OWNER),
  admin: Object.freeze(ADMIN),
  operator: Object.freeze(OPERATOR),
  viewer: Object.freeze(VIEWER),
});

// The roles an owner gives to others: one owner, made at setup.
export const ASSIGNABLE = Object.freeze(['admin', 'operator', 'viewer']);

export const scopesOf = (role) => ROLES[role] || [];
