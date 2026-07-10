# Bundled skills — sources & licenses

Pi Desktop ships a small set of high-quality **skills** (agent playbooks the pi
engine loads from `~/.pi/agent/skills/<name>/SKILL.md`). This directory is the
read-only source; installing a skill copies its folder into that agent dir.

Two provenances, both permissive and redistributable:

## Apache-2.0 — vendored from `anthropics/skills`

Copied verbatim (SKILL.md + any `reference/`, `scripts/`, `examples/`) from
<https://github.com/anthropics/skills> (© Anthropic). Each folder keeps its
upstream `LICENSE.txt` (the full Apache License, Version 2.0). Redistributed
here under the same license, with attribution, unmodified.

- `doc-coauthoring` — structured workflow for co-authoring docs/specs/proposals.
- `mcp-builder` — guide + scaffolding for building high-quality MCP servers
  (Python FastMCP / Node TS SDK). Pairs with the Connectors story.
- `webapp-testing` — drive/test local web apps with Playwright (verify UI,
  capture screenshots, read console logs).
- `internal-comms` — write internal comms (status reports, updates, FAQs,
  incident reports) in common company formats.

Only the four **Apache-2.0** example skills are bundled. The four **document
skills** in that repo (`pdf`, `xlsx`, `docx`, `pptx`) are source-available but
**not permissively licensed**, so they are NOT redistributed here — permissive
in-house equivalents (`pdf-toolkit`, `spreadsheet-toolkit`) are provided instead.

## MIT — authored in-house for Pi Desktop

Original skills written for this project, © 2026 Pi Desktop contributors, MIT
(same license as the app — see the repo `LICENSE`):

- `code-review`, `git-workflow`, `data-analysis`, `web-research`,
  `pdf-toolkit`, `spreadsheet-toolkit`, `debugging`, `writing-docs`.

See `packages`/`apps/desktop/electron/skills/skills-registry.ts` for the typed
registry (id, name, description, source, license) that drives the Skills tab.
