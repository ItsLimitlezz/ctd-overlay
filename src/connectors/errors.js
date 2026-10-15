// What the connector host refuses, with the status the API answers (http/api.js problemOf):
//   not-found 404 · invalid, unknown-field, unknown-connector, no-sign-in 422 · not-connected,
//   needs-reauth, busy, conflict 409 · flow-expired 410 · session-required 403 · rate-limited,
//   quota-exhausted 429 (+ Retry-After) · action-failed 502 · timeout 504.
const STATUS = {
  'not-found': 404, invalid: 422, 'unknown-field': 422, 'unknown-connector': 422, 'no-sign-in': 422,
  'not-connected': 409, 'needs-reauth': 409, busy: 409, conflict: 409,
  'flow-expired': 410, 'session-required': 403,
  'rate-limited': 429, 'quota-exhausted': 429,
  'action-failed': 502, timeout: 504,
};

export class ConnectorError extends Error {
  constructor(message, code = 'invalid', { status, retryAfterS } = {}) {
    super(message);
    this.name = 'ConnectorError';
    this.code = code;
    this.status = status ?? STATUS[code] ?? 422;
    if (retryAfterS !== undefined) this.retryAfterS = retryAfterS;
  }
}
