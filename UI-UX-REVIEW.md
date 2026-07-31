# Bobble — new-user UI/UX review

**Reviewer:** first-time user, never seen the app.
**Time spent:** ~11 minutes driving the app + ~6 minutes writing. Hard 20-minute cap.
**Method:** built Electron app driven headlessly via Playwright (same rig as `apps/desktop/tests/e2e/live-probe.mjs`), three launches: (1) the existing profile with chat history, (2) a clean `HOME` = true empty profile, (3) a clean `HOME` with `PI_ONBOARDING=1` to reach the first-run wizard. 29 screenshots, all read.

**What I did NOT get to** — say so plainly:
- No real model reply. I never waited out inference; every finding below is about the interface.
- Did not open: 3D Studio, the Connectors browse list ("Open connectors"), Settings → Appearance / Interface / Web search / Custom instructions, the `@` files picker, `/` commands, `!` bash, the project chip menu, chat right-click menus, message hover actions, keyboard nav, window resize / small-window layout, light-mode settings pages.
- Did not test with a model actually downloaded, so I never saw a healthy turn on a fresh profile.
- Marked **[unverified]** anywhere I am inferring rather than reporting what rendered.

---

## First 60 seconds

**With the first-run wizard (`PI_ONBOARDING=1`, clean profile):** a clean, light, well-built 5-step wizard. Step 1 is "Welcome to Bobble — Where are you coming from?" offering *Coming from Claude* / *Coming from Codex* / *Neither — start fresh*. My honest reaction: this app thinks I already use a developer AI CLI. Nothing on the welcome screen tells me what Bobble **is** — not one sentence saying it runs AI models locally on my Mac, offline, for free. I am asked to migrate before I am told what I am migrating into. Step 4 ("How much guidance?") is genuinely excellent. Step 5 mentions, in a grey line at the bottom, that I will need a chat model. Then setup finishes and **no model is downloaded**.

I land in an empty chat titled "Bobble / What are we building?". A "Getting started" card sits in the bottom-left corner. The composer looks completely ready — placeholder "Ask anything…", attach button, mic, a chip reading **"Auto · unknown"**. So I type "hello, what can you do?" and press Enter.

A modal appears offering to download `gemma4 12b` (7.1 GB). Good. But I close it — I did not ask to download 7 GB, I asked a question. **My message sends anyway.** The chat now reads `processing · 34.3s`, counting up, forever, with no model on disk and no error. That is where a real new user gives up.

**Without the wizard (clean profile, normal launch):** you are dropped straight into the empty chat, no welcome at all. *(The wizard is deliberately skipped under `PI_E2E=1` — `apps/desktop/electron/import/import-main.ts:261` — so I cannot say whether a real user on a real first launch sees it. **[unverified]** whether the wizard reliably fires outside E2E.)*

---

## What works well

These are concrete and worth protecting.

1. **Onboarding step 4, "How much guidance?"** — three choices ("I've never run a local model" / "I know what llama.cpp is" / "Leave me alone, no tutorial") and each one **states its consequence** underneath: `Permissions: review every action · tutorial on`. Tying an identity question to a concrete permission default, and showing the default, is better than most commercial apps. `apps/desktop/src/onboarding/steps/ExperienceStep.tsx`. (Shot 34.)

2. **The canvas empty state** is the best empty state in the app: "Nothing on the canvas yet / Open a file tree, a browser, a terminal, or your subagents" with four labelled buttons and shortcuts (`⌘P`, `⌘T`). It names the capability *and* hands you the action. This is exactly what the chat empty state should be doing. (Shot 11.)

3. **The Models page reads the machine**: "Apple M5 Pro · 24 GB RAM" in the subtitle, a "Fits comfortably" badge per model, and the primary button rewrites itself by state — "Download & start recommended model" on a fresh profile, "Start recommended model" once present. That is real care. (Shots 01, 21.)

4. **Model tabs advertise scope**: Language / Image / Video / Audio / Music / 3D / Perception across the top of the Models page is the clearest statement anywhere that this app does more than chat.

5. **Transcript typography** is good — comfortable line height, clean bold/list rendering, and a compact one-line activity summary ("Thought for 7s, visited a page, read the page") instead of a wall of tool spam. (Shot 13.)

6. **The just-in-time download modal** is well-judged in isolation: model name, `Verified`, `Recommended`, `7.1 GB`, `Balanced response speed`, one primary button. Right idea, right moment. (Shot 43.)

7. **Light mode is handsome** — `rgb(245,245,247)` ground, restrained borders, no heavy chrome. (Shot 44.)

---

## What is confusing or broken

Ordered by cost to a new user.

### 1. Closing the download modal still sends the message, into a spinner that never ends
**Saw:** typed "hello, what can you do?" → Enter → download modal → closed it → the user bubble is posted and the chat sits at `processing · 34.3s` and climbing, on a profile with zero models. No error, no timeout, no "you need a model", no way to tell it is hopeless. Sidebar shows a spinner on the chat forever. (Shots 43, 44.)
**Cost:** this is the terminal newcomer experience. They conclude the app is broken, not that they skipped a step.
**Fix:** dismissing the model dialog must cancel the pending send and restore the draft to the composer. If a send ever proceeds with no runnable model, fail fast with an actionable assistant-slot error: "No model installed — [Download gemma4 12b, 7.1 GB]".

### 2. The composer looks fully functional with no model, and says "Auto · unknown"
**Saw:** fresh profile composer: placeholder "Ask anything…", enabled send, model chip reading **`Auto · unknown`** (`data-testid="footer-model-chip"`, `apps/desktop/src/chat/ComposerBar.tsx`). "unknown" is a null value leaking into the UI. (Shots 00-launch fresh, 20.)
**Cost:** every affordance says "ready", so the user commits a question before learning the app cannot answer. It also wastes the one chance to make the required next step obvious.
**Fix:** when no model is installed, the chip should read "No model — download one" and be the accent-coloured element on screen; the placeholder should read "Download a model to start"; the send button disabled with a tooltip.

### 3. Two of the four Workspace nav items are dead "Coming soon" modals — and the modal traps you
**Saw:** sidebar → **Scheduled** → modal: "Run Pi on a schedule and review the results. Coming soon." Sidebar → **Skills** → "Browse and manage the skills Pi can use. Coming soon." (`apps/desktop/src/chat/ChatApp.tsx:111,113`.) **Escape does not close them** — I verified the `.pd-stub-overlay` was still mounted after an Escape keypress and it swallowed my next click on the composer. Only the × works. `Skills` also appears in the composer "+" menu, so the dead end is reachable two ways. (Shots 06, 07.)
**Cost:** half the top-level workspace nav does nothing, which reads as an abandoned app; and a keyboard user is stuck in a modal that has no content.
**Fix:** either remove them from the nav until they ship or mark them inline (greyed with a "Soon" pill, non-clickable). Regardless: wire Escape + backdrop-click to close `pd-stub-overlay`.

### 4. "Pi" leaks into user-facing copy — including the first thing a new user reads
**Saw:** the "Getting started" card's third tip is literally **"Give Pi tools & skills"** (`apps/desktop/src/onboarding/FirstRunTips.tsx:44`). Also "Run **Pi** on a schedule", "the skills **Pi** can use" (`ChatApp.tsx:111,113`), and Settings → Connectors: "Connectors run as a `pi-tool` shell command". (Shots 40, 06, 07, 03.)
**Cost:** the app introduces itself as Bobble and then refers to itself by a name the user has never seen, in the onboarding tips. It reads like an unfinished rebrand.
**Fix:** sweep user-visible strings for "Pi"; keep internals as-is.

### 5. One model, three different sizes; one model, three different names
**Saw:** onboarding step 5 — "Gemma 4 12B Instruct (**16 GB**)". Models page — "needs **~16GB**". The download modal — "**7.1 GB**". Names: `Gemma 4 12B Instruct` (Models) / `gemma4 12b` (composer chip and modal) / `Gemma 4 12B Instruct Q4_K_M` (recommendation card). (Shots 35, 21, 09, 43.)
**Cost:** the newcomer's only real question is "do I have room for this?" and the app answers it three ways without ever labelling which number is disk and which is RAM.
**Fix:** one canonical display name and two explicitly labelled figures: "Download 7.1 GB · needs ~16 GB RAM".

### 6. "Balanced" means two different things in two adjacent controls, and effort has four vocabularies
**Saw:** the model chip menu lists tiers `Fast` / `Balanced` / `Intelligent`; six pixels away the effort chip reads `Effort · Balanced`. Same word, different axis. And effort is named four ways across the app: **Balanced** (composer chip), **Faster ↔ Smarter** slider + **Auto** (its popover), **Low / Medium / High / Max** (Settings → Agent), **Adaptive** (composer chip on a fresh profile). (Shots 08, 09, 04, 00-fresh.)
**Cost:** the user cannot build a mental model of what they are adjusting, and cannot map the setting they changed in Settings to the chip in front of them.
**Fix:** pick one scale and one set of words, and make the composer chip and the settings row use them verbatim.

### 7. The effort popover renders on top of the composer it belongs to
**Saw:** clicking `Effort · Balanced` opens a popover anchored **above** the chip that covers the right half of the text input, and its "Auto" row is clipped by the composer's own dropdown caret. You cannot see your prompt while choosing effort for it. (Shot 08.)
**Fix:** anchor it above the composer's outer bounds, or flip it below.

### 8. Capability is hidden behind an unlabelled "+"
**Saw:** the "+" menu (`aria-label="Add to message"`, no visible label) is where the app's actual range lives: Generate image, Generate video, Motion graphics, Find/segment in image or video, Research, Web search, Add connector, Add plugins, Add from GitHub, Take a screenshot. The chat empty state offers none of it — just "What are we building?" and three tiny grey hints (`@ files`, `/ commands`, `! bash`). Browsing the web and controlling the Mac appear nowhere at all in the UI **[unverified — I did not open `/ commands`]**. 3D Studio is buried under a collapsible "Modalities" group. (Shots 10, 00, 44.)
**Cost:** a newcomer will use this as a plain chatbot forever and never discover the parts that make it worth installing.
**Fix:** put 4–6 suggestion chips in the chat empty state, drawn from that same menu ("Generate an image", "Search the web", "Open a file"). The canvas empty state already proves the pattern works.

### 9. Settings → Connectors is written for the developer who built it
**Saw:** "How MCP connector tools are exposed to the agent"; a three-way segmented control **Lite / Native / Bash CLI** with the helper text "Connectors run as a `pi-tool` shell command in bash (best for small models)". Below it, the one thing a user actually wants — "Open connectors" — is styled as a flat dark secondary button, visually weaker than the knob nobody can use. (Shot 03.)
**Cost:** a newcomer cannot choose between Lite / Native / Bash CLI on any basis, and the discoverable action is the least prominent thing on the page.
**Fix:** lead with "Browse connectors" as the accent primary; move the MCP mode selector behind an "Advanced" disclosure.

### 10. Settings → Agent orders the permission options least-safe-first, with no risk styling
**Saw:** `Bypass | Reviewer | Review all`, with "Bypass" leftmost and its description "Run every tool call without review — fastest, least safe" in the same grey as every other helper text. Onboarding presents the same three choices in the opposite (safe-first) order. (Shots 04, 34.)
**Cost:** for an app that runs shell commands and drives the Mac, the least-safe option sits in the position users read first and scan as the default, and the two screens contradict each other.
**Fix:** order safest → least safe on both screens, matching onboarding, and give "Bypass" a warning treatment.

### 11. Model-management jargon has zero explanation
**Saw:** `Q4_K_M`, `MTP`, `Q8_0`, `UD-Q6_K_XL`, `33K context`, `unsloth`, `Apache-2.0` on the model cards. I checked programmatically: **none of these badges carry a `title` or tooltip** — they are bare text. (Shot 01, 21.)
**Cost:** the page tells the user their choice matters and then encodes the entire basis for it.
**Fix:** tooltips on the badges; a one-line plain-English summary per card ("smaller file, slightly lower quality").

### 12. The chat header shows "Chat" instead of the chat's title
**Saw:** sidebar row reads "hello, what can you do?" / "Screenshot example.com" while the window header reads just **"Chat"**. On a new chat the header correctly reads "New chat". (Shots 13, 44.)
**Cost:** small, but it removes the one always-visible confirmation of where you are.
**Fix:** show the session title in the header.

### 13. The app opens in dark, then switches to the light theme you chose
**Saw:** I chose Bobble + **Light** in the wizard (step 3 even live-previews it). At t+3s after "Finish setup" the app rendered **dark**, with the light "Getting started" card sitting on it — clashing. Seconds later `document.body` background was `rgb(245,245,247)`, i.e. light. (Shots 40 vs 44.)
**Cost:** the first frame after setup contradicts the choice just made, and the mixed-theme moment looks broken.
**Fix:** apply the persisted theme before the chat window paints.

### 14. Two "Connectors" that go to different places
**Saw:** "Connectors" in the chat sidebar's Workspace group, and "Connectors" in the Settings sidebar — same label, different destinations. Likewise "Model management" (chat sidebar) navigates into Settings → Models, replacing the whole window, with a small "Back to chat" at the bottom-left. (Shots 00, 01, 03.)
**Cost:** clicking a sidebar item and having the entire app become Settings is disorienting the first time; and the duplicated label makes it unclear which one browses connectors.
**Fix:** rename the settings one "Connector settings", and either mark the workspace items with a settings/arrow glyph or open them as a sheet over the chat.

### 15. Minor, verified
- **Unlabelled gauge** in the composer bar (`svg.pd-gauge`, left of the effort chip) with no `title`, `aria-label` or text. **[unverified]** what it measures — context usage, presumably. Give it a tooltip.
- **"Local · signed out"** in the settings header. Signed out of what, on an offline app? Invites a question with no answer.
- **Disabled "Continue" on onboarding step 4** looks identical to the enabled one on steps 1–3 (same accent class, `opacity: 0.5`) and nothing is preselected, so clicking it silently does nothing. Add "Pick one to continue" or preselect the safe option.
- **"Back" is rendered on step 1** where there is nowhere to go back to.
- **A "New chat" already exists** in the sidebar before the user has done anything.
- **Fresh Models page shows "Use" on models that are not downloaded**, while cards lower down show "Download" — so there is no way to tell what is on disk.

---

## What's missing

- **A sentence saying what Bobble is.** Not in the wizard, not in the empty state. A newcomer never learns it is a fully local, offline AI that runs on their own machine — which is the entire reason to choose it.
- **Getting a model is not part of setup.** The wizard collects theme, experience and generation capabilities, but ends with the app unable to answer a single question. The 7.1 GB download should be an explicit step 6 with a progress bar, not a grey footnote.
- **No capability surface on the main screen.** No suggestion chips, no examples, no "what can this do" affordance. Everything is behind a "+".
- **Web browsing and Mac control are invisible.** Both clearly exist (the sample chat history is full of "Open Khan Academy", "Screenshot example.com", "can you make my screen sav…"). Nothing in the UI advertises them.
- **No Help / docs / keyboard-shortcut reference** anywhere I found, and no way to re-open the "Getting started" tips after "Got it" **[unverified — there is a "Redo onboarding" in Settings → Interface per `App.tsx:80`, which I did not open]**.
- **No download-size or disk-usage view.** Nothing tells you how much space models are consuming.
- **Projects are never explained.** The composer has a project chip ("No project"), the sidebar has a "Projects" section, and nothing says what a project does for you.

---

## Screenshot index

All under `/private/tmp/claude-501/-Users-jedd-Desktop-OSS-harness/93ed9768-a848-490e-9e55-ae3d3654b143/scratchpad/shots/` (session scratchpad — copy them out if you want to keep them).

| File | What it shows |
| --- | --- |
| `30-onboarding-step1.png` | First-run wizard step 1: "Where are you coming from?" — Claude / Codex / start fresh |
| `32-onboarding-step2.png` | Wizard step 2 (import) |
| `33-onboarding-step3.png` | Wizard step 3: theme flavour + Dark/Light with live preview |
| `34-onboarding-step4.png` | Wizard step 4: "How much guidance?" — the best screen in the app |
| `35-onboarding-step5.png` / `37-step5.png` | Wizard step 5: generation capability toggles + the "(16 GB)" model footnote |
| `40-first-chat.png` | **The first 60 seconds**: empty chat, "Auto · unknown", light "Getting started" card on a dark app, "Give Pi tools & skills" |
| `43-no-model-send.png` | The just-in-time download modal — `gemma4 12b`, 7.1 GB |
| `44-light-empty.png` | **The failure**: message sent with no model, stuck at `processing · 34.3s`; header says "Chat" |
| `00-launch.png` | Clean-profile empty chat (no wizard, `PI_E2E=1`), "No projects yet." |
| `20-model-info.png` | Composer bar on a fresh profile: `Auto · unknown` + "Turn stats" ⓘ |
| `21-fresh-models.png` | Models page, fresh profile — "Download & start recommended model" |
| `01-model-management.png` | Models page, existing profile — jargon badges (Q4_K_M, MTP, Q8_0), duplicate recommendation |
| `02-capabilities.png` | Settings → Capabilities: image / video / audio / 3D toggles |
| `03-connectors.png` | Settings → Connectors: MCP mode Lite/Native/Bash CLI, weak "Open connectors" |
| `04-agent-settings.png` | Settings → Agent: Bypass-first permissions, Low/Medium/High/Max effort |
| `06-skills.png` | Skills → "Coming soon" stub modal ("skills Pi can use") |
| `07-scheduled.png` | Scheduled → "Coming soon" stub modal ("Run Pi on a schedule") |
| `08-effort-menu.png` | Effort popover overlapping the composer text area |
| `09-model-chip.png` | Model tier menu: Auto / Fast / Balanced / Intelligent — "Balanced" collision |
| `10-add-menu.png` | The "+" menu — where all the capability is hidden |
| `11-canvas.png` | Canvas empty state — the app's best empty state |
| `12-advanced.png` | Advanced parameters modal (power-user sampling knobs) |
| `13-existing-chat.png` | A real transcript: markdown rendering + "Thought for 7s, visited a page" |
