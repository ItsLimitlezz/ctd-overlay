// A show's or an overlay's `followObs` (follow.js, 09 §9.7): which OBS canvas drives it, whose OBS,
// and OBS scene → overlay scene. Checked here for the shows and the overlays alike.
//
//   { enabled, canvas: "landscape" | "vertical", source?, map: [{ obsScene, obsSceneUuid?, scene }],
//     otherwise? }

export const CANVASES = ['landscape', 'vertical'];
export const OBS_SCENE_CHARS = 200;
const ROWS = 50;
export const FOLLOW_OBS_FIELDS = ['enabled', 'canvas', 'source', 'map', 'otherwise'];
const FIELDS = FOLLOW_OBS_FIELDS;
const ROW_FIELDS = ['obsScene', 'obsSceneUuid', 'scene'];
// A feed as bindings name it (overlays/registry.js): a connection id, or "<connection>/<profile>".
const SOURCE = /^[\x21-\x2e\x30-\x7e]{1,64}(?:\/[^\s/]{1,100})?$/;
const UUID = /^[\x21-\x7e]{1,100}$/;

// A followObs as the API takes it, checked: null removes it. sceneOk(id) says whether the members'
// templates have the scene (by id or core); bad(message, code?) throws the caller's error.
export function cleanFollowObs(input, { sceneOk, bad }) {
  if (input === null) return null;
  if (!input || typeof input !== 'object' || Array.isArray(input)) bad('"followObs" is { enabled, canvas, source?, map, otherwise? }, or null to stop following OBS.');
  const unknown = Object.keys(input).filter((k) => !FIELDS.includes(k));
  if (unknown.length) bad(`"followObs": unknown field${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')}; it has ${FIELDS.join(', ')}.`, 'unknown-field');
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') bad('"followObs.enabled" is true or false.');
  const canvas = input.canvas ?? 'landscape';
  if (!CANVASES.includes(canvas)) bad('"followObs.canvas" is "landscape" or "vertical": the OBS canvas whose scene it follows.');
  const source = input.source ?? undefined;
  if (source !== undefined && source !== '' && (typeof source !== 'string' || !SOURCE.test(source))) bad('"followObs.source" is whose OBS it follows: a connection id, or "<connection id>/<profile id>" (one CTD Relay profile); empty for the one that feeds it.');
  const scene = (id, what) => {
    if (typeof id !== 'string' || !id || !sceneOk(id)) bad(`${what}: no overlay's template here has a scene "${typeof id === 'string' ? id : JSON.stringify(id)}".`, 'unknown-scene');
    return id;
  };
  const map = input.map ?? [];
  if (!Array.isArray(map) || map.length > ROWS) bad(`"followObs.map" is a list of at most ${ROWS} { obsScene, obsSceneUuid?, scene }.`);
  const rows = map.map((r, i) => {
    const at = `"followObs.map" row ${i + 1}`;
    if (!r || typeof r !== 'object' || Array.isArray(r)) bad(`${at} is { obsScene, obsSceneUuid?, scene }.`);
    const extra = Object.keys(r).filter((k) => !ROW_FIELDS.includes(k));
    if (extra.length) bad(`${at}: unknown field${extra.length > 1 ? 's' : ''} ${extra.join(', ')}; a row has ${ROW_FIELDS.join(', ')}.`, 'unknown-field');
    if (typeof r.obsScene !== 'string' || !r.obsScene || r.obsScene.length > OBS_SCENE_CHARS) bad(`${at}: "obsScene" is the OBS scene's name, at most ${OBS_SCENE_CHARS} characters.`);
    const uuid = r.obsSceneUuid ?? undefined;
    if (uuid !== undefined && uuid !== '' && (typeof uuid !== 'string' || !UUID.test(uuid))) bad(`${at}: "obsSceneUuid" is the OBS scene's uuid, at most 100 characters.`);
    return { obsScene: r.obsScene, ...(uuid ? { obsSceneUuid: uuid } : {}), scene: scene(r.scene, at) };
  });
  const names = rows.map((r) => r.obsScene);
  const twice = names.find((n, i) => names.indexOf(n) !== i);
  if (twice !== undefined) bad(`"followObs.map" has the OBS scene "${twice}" twice: one overlay scene per OBS scene.`);
  const otherwise = input.otherwise ?? undefined;
  return {
    enabled: input.enabled === true,
    canvas,
    ...(source ? { source } : {}),
    map: rows,
    ...(otherwise !== undefined && otherwise !== '' ? { otherwise: scene(otherwise, '"followObs.otherwise"') } : {}),
  };
}

// The scene a followObs maps an OBS scene ({ scene, sceneUuid? }) to: by uuid, else by name, else
// otherwise (undefined: leave the scene as it is).
export function mappedScene(follow, value) {
  const rows = Array.isArray(follow?.map) ? follow.map : [];
  const byUuid = value?.sceneUuid ? rows.find((r) => r.obsSceneUuid && r.obsSceneUuid === value.sceneUuid) : undefined;
  return (byUuid || rows.find((r) => r.obsScene === value?.scene))?.scene ?? follow?.otherwise;
}
