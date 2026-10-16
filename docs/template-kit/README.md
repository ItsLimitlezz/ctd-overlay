# Template kit

Everything to design overlay templates for CTD Overlay, or to have an AI assistant generate them:

- [TEMPLATE-GUIDE.md](TEMPLATE-GUIDE.md): the complete authoring guide (package, manifest,
  settings, the data, the `SK` SDK, scenes, actions, chat, alerts, motion, rules, testing).
- [mega/](mega/): a reference show package that uses every feature (it validates and installs:
  `npm run skp -- template install docs/template-kit/mega`).
- [PROMPT.md](PROMPT.md): a ready-to-use prompt; give it, the guide and `mega/` to an assistant with
  your brief.

The bundled templates are good smaller examples: `templates/chat`, `templates/alerts`,
`templates/viewers`, and the full D/PRTMNT show package `templates/takeover`.
