# Animation preset previews — offline generator

Renders the 3D studio's animation-preset preview videos + posters
(`apps/desktop/src/tripo/assets/anim-previews/`) from a real Mixamo humanoid
dummy. Inputs (not committed):

- `~/Downloads/model.fbx` — the humanoid dummy (Mixamo rig, 119 bones).
- `~/Downloads/source/Macarena Dance.fbx` — the dance clip, played on its own
  bundled character (cross-rig quaternion retargeting distorts, so dance_01
  renders that character directly).

All other presets are procedurally-authored bone clips on the mixamorig
skeleton (see `makeClip` in main.js) — real skeletal animation matching each
preset's name, arms lowered from T-pose by default.

Run:
    cd scripts/anim-previews
    <repo>/apps/desktop/node_modules/.bin/vite build --config vite.config.mjs
    node generate.mjs   # uses installed Chrome via playwright-core

Each preset records a ~1.6s (dance: 3.2s) 320×400 vp9 webm + a mid-motion
JPEG poster, then writes the manifest module (index.ts).
