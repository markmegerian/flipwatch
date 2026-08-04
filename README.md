# Flipwatch — published site

This branch is the **deploy artifact** for GitHub Pages. It intentionally contains
only the public web surface, so enabling Pages on this branch publishes the app and
the privacy policy and nothing else from the project.

| Path            | What it is                                            |
| --------------- | ----------------------------------------------------- |
| `index.html`    | The mobile web app (installs to a phone home screen)  |
| `privacy.html`  | Privacy policy — the URL the Chrome Web Store needs   |
| `manifest.webmanifest`, `icon*.png` | Home-screen app metadata          |

Source of truth is `site/` on `main`. Regenerate rather than editing here.

**To publish:** Settings → Pages → Source: *Deploy from a branch* → Branch: `gh-pages` → Folder: `/ (root)` → Save.
