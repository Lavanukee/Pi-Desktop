---
name: writing-docs
description: Write clear technical documentation — READMEs, how-to guides, API references, tutorials, and reference docs. Use when the user wants to document a project, feature, or API, or wants existing docs made clearer, better structured, or more complete.
license: MIT (© 2026 Pi Desktop contributors)
---

# Writing docs

Good docs answer a reader's question fast. Write for a specific reader with a
specific goal, and lead with what they need.

## First, know the reader

- Who is reading, and what are they trying to *do*? (Evaluate? Install? Call an API?
  Understand a design?)
- What do they already know? Match vocabulary and depth to that — don't over- or
  under-explain.

## Pick the right doc type (Diátaxis)

- **Tutorial** — a guided, hands-on lesson for a newcomer. Concrete, ordered steps
  that succeed.
- **How-to** — steps to accomplish one real task. Assumes some context; goal-oriented.
- **Reference** — accurate, exhaustive description (API, config, CLI). Consistent and
  scannable, not narrative.
- **Explanation** — the *why*: concepts, trade-offs, architecture.

Don't blend them in one section — a tutorial that keeps digressing into concepts
loses the reader.

## Structure

- Start with the point: what this is and who it's for, in the first two lines.
- One idea per section; descriptive headings so readers can scan and jump.
- Show, then tell: a working example before the prose. Every code block should be
  runnable/copy-pasteable and actually correct.
- Put prerequisites and gotchas where they're needed, not buried at the end.

## Write clearly

- Short sentences, active voice, present tense: "Run `x`", not "`x` should be run".
- Be concrete: real commands, real values, expected output — not "configure as
  appropriate".
- Define a term once, then use it consistently. Cut filler ("simply", "just",
  "obviously") and hedging.

## For a README specifically

Lead with: what it is (one line) → why you'd use it → install → a minimal working
example → links to deeper docs. Keep it short; link out rather than inlining
everything.

## Finish

- Verify every command and code sample runs as written.
- Re-read as the target reader: can they reach their goal without getting stuck or
  guessing? Remove anything that doesn't serve that.
