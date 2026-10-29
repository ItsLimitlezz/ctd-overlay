// What an action needs of an overlay's settings to show anything, where its manifest doesn't say
// (04 §4.6), by template: the media a setting names (TAKEOVER's Play The Line's clip), or a look and
// a switch (TAKEOVER's chips in its Headliner event look, with them on; its Now playing there with
// the lower third on). Live's buttons and toasts say it (live-overlay.js, live.js), a cue's
// Graphic says it (shows.js), and so does the upgrade dialog for an action a version brings
// (overlays.js).
//
//   MEDIA_ACTIONS[id]           { setting, what }: it plays the media that setting names
//   notDrawn(overlay, id)       why the overlay shows nothing for it with its settings as they are,
//                               or undefined
//   drawnOnlySo(id)             whether some template draws it only with some settings
//   needsWords(template, id)    what it needs, in words for a version that brings it, or undefined

export const MEDIA_ACTIONS = { linePlay: { setting: 'lineClip', what: 'The Line\'s clip' } };

const chips = {
  why: (s) => (s.look !== 'event' ? 'the chips show in the Headliner event look only' : s.scheduleChips === false ? '"Opening and on-at chips" is off in its settings' : undefined),
  needs: 'it shows in the Headliner event look only (Look), with "Opening and on-at chips" on',
};
const nowPlaying = {
  why: (s) => (s.look === 'event' && s.nowPlayingBar === false ? '"Now playing lower third" is off in its settings' : undefined),
  needs: 'in the Headliner event look it shows only with "Now playing lower third" on',
};
const ONLY_WHEN = { 'com.dprtmnt.takeover': { chipOpening: chips, chipOnAt: chips, nowPlaying, nowPlayingHold: nowPlaying } };

export function notDrawn(overlay, id) {
  const rule = ONLY_WHEN[overlay?.template?.id]?.[id];
  const s = overlay?.resolvedSettings || overlay?.settings;
  return rule && s && typeof s === 'object' ? rule.why(s) : undefined;
}

export const drawnOnlySo = (id) => Object.values(ONLY_WHEN).some((rules) => rules[id]);

// setting(name) → the setting's title as its form shows it, for a media action's.
export function needsWords(template, id, setting = (name) => name) {
  const media = MEDIA_ACTIONS[id];
  if (media) return `it plays the clip chosen in the overlay's settings ("${setting(media.setting)}", a video uploaded in Media), so choose one before the show`;
  return ONLY_WHEN[template]?.[id]?.needs;
}
