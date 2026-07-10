---
name: code-review
description: Review a code change (a diff, PR, or working tree) for correctness bugs and for reuse / simplification / efficiency cleanups. Use when the user asks to review code, check a diff, look for bugs before committing, or tighten up a change. Effort-tiered — do fewer, higher-confidence findings by default; go broad only when asked.
license: MIT (© 2026 Pi Desktop contributors)
---

# Code review

Review a change and report the findings. Two independent lenses — **correctness**
(does it do what it should?) and **quality** (is it the simplest correct version?).
Keep the signal-to-noise ratio high: a short list of real findings beats a long
list of nitpicks.

## Scope the review first

1. Identify what actually changed. Prefer `git diff` (unstaged), `git diff --staged`,
   or `git diff <base>...HEAD` for a branch. Review the diff, not the whole repo.
2. Read enough surrounding code to understand each hunk in context — a line can be
   correct in isolation but wrong given its caller.
3. Note the change's intent (commit message, PR title, the user's ask) so you can
   judge whether it achieves it.

## Correctness pass (find bugs)

Look for defects the change introduces or leaves behind:

- Logic errors: off-by-one, inverted conditions, wrong operator, bad boundary.
- Missing cases: null/undefined/empty, error paths, early returns, `default:`.
- Async: unawaited promises, races, unhandled rejections, missing cancellation.
- Resource + state: leaks (files, handles, listeners), mutation of shared state,
  stale caches.
- Data: type coercion surprises, encoding, precision, timezone, integer overflow.
- Security: unvalidated input, path traversal, injection, secrets in logs, unsafe
  deserialization.
- Contract drift: a signature/schema/return shape changed but a caller wasn't.

For each, state the concrete failure (input → wrong behavior), not a vague worry.

## Quality pass (simplify, reuse, tighten)

- Reuse: is there an existing helper/util that already does this? Duplicated logic?
- Simplify: dead code, redundant branches, over-abstraction, needless intermediate
  state, a loop that a built-in expresses more clearly.
- Efficiency: accidental O(n²), repeated work in a loop, unnecessary allocations or
  round-trips — only when it matters at the expected scale.
- Consistency: naming, error handling, and patterns that match the surrounding file.

## Report

Group by severity: **must-fix** (correctness), then **should-fix**, then optional
**nits**. For each finding give: file:line, one-line description, why it matters,
and a suggested fix. If you found nothing material, say so plainly rather than
inventing filler. Do not restate what the code does — only what should change.

## Effort tiers

- Default / low–medium: only high-confidence findings; skip stylistic nits.
- High: broader coverage, including plausible-but-uncertain issues (flag the
  uncertainty).
