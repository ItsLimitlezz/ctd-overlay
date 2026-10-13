// What every API request must be, signed in or not (auth/routes.js adds who is asking). Web pages
// can send requests to the platform: another site's page in the operator's browser, and a
// template's own script, which overlay pages run sandboxed, with an origin of their own ("null"),
// never the platform's (overlays/routes.js, 04 §4.8). So a request must:
// - be addressed to the platform by one of its own names (hosts(): 127.0.0.1, localhost or [::1]
//   with its port, and the configured host), checked against those fixed names, never against
//   the Host the request brought: a DNS-rebinding page sends a Host and an Origin that match;
// - come from the platform's own origin if it names one: the admin UI's pages (signed in, with
//   the CSRF token), or a program (the command line sends no Origin);
// - carry JSON, when it has a body: a cross-site JSON request needs a CORS preflight, which this
//   server never grants.
import { readBody, sendProblem } from './server.js';

export function refusedHere(req, res, hosts) {
  const own = hosts();
  const origin = req.headers.origin;
  if (own.includes(String(req.headers.host || '').toLowerCase()) && (origin === undefined || own.some((h) => origin === `http://${h}`))) return false;
  sendProblem(res, 403, 'Forbidden', 'This can only be requested from the platform\'s own pages or programs on this machine, at the platform\'s own address.');
  return true;
}

// The request's JSON body, or undefined once a problem has been sent. An empty body is {}.
export async function jsonBody(req, res, limit) {
  const declared = req.headers['content-length'];
  const hasBody = (declared !== undefined && declared !== '0') || req.headers['transfer-encoding'] !== undefined;
  if (hasBody && !/^application\/json\b/i.test(req.headers['content-type'] || '')) {
    sendProblem(res, 415, 'Unsupported media type', 'Send a JSON body with Content-Type: application/json.');
    return undefined;
  }
  let text;
  try {
    text = await readBody(req, limit);
  } catch (err) {
    if (err.status) sendProblem(res, err.status, 'Body too large', err.message, { headers: err.headers });
    else sendProblem(res, 400, 'Bad request', 'The body could not be read.');
    return undefined;
  }
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    sendProblem(res, 400, 'Bad request', 'The body is not valid JSON.');
    return undefined;
  }
}
