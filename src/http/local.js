// The control routes before sign-in exists (steps 11–13): shows, scenes, triggers, simulation.
// The server listens on this machine only, but web pages open on it can still send requests to
// it: another site's page in the operator's browser, and a template's own script, which runs on
// the platform's origin in OBS. Until sign-in tells them apart, a control request must:
// - be addressed to the platform by one of its own names (hosts(): 127.0.0.1, localhost or [::1]
//   with its port, and the configured host), checked against those fixed names, never against
//   the Host the request brought: a DNS-rebinding page sends a Host and an Origin that match;
// - not come from a web page at all: a browser marks every page's request with Origin (or
//   Sec-Fetch-Site other than "none"); the command line and other local programs send neither;
// - carry JSON, when it has a body: a cross-site JSON request needs a CORS preflight, which this
//   server never grants.
import { readBody, sendProblem } from './server.js';

export function refusedHere(req, res, hosts) {
  const own = hosts();
  const site = req.headers['sec-fetch-site'];
  if (own.includes(String(req.headers.host || '').toLowerCase()) && req.headers.origin === undefined && (site === undefined || site === 'none')) return false;
  sendProblem(res, 403, 'Forbidden', 'This can only be requested from this machine by a program such as the skp command line, at the platform\'s own address; web pages (templates included) can\'t, until sign-in exists.');
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
