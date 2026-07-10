---
name: debugging
description: Systematically diagnose and fix a bug — reproduce, isolate, form and test a hypothesis, fix the root cause, then verify. Use when something is broken, throwing, crashing, flaky, or producing wrong output and the cause isn't obvious.
license: MIT (© 2026 Pi Desktop contributors)
---

# Debugging

Find the root cause before changing code. Resist the urge to guess-and-patch — a fix
you can't explain usually isn't one.

## 1. Reproduce

- Get a reliable, minimal repro: exact input, command, and environment that triggers
  it. A bug you can't reproduce, you can't confirm you fixed.
- Capture the actual signal: full error + stack trace, logs, exit code, the wrong
  output vs. the expected output.
- If it's intermittent, note frequency and any pattern (load, timing, ordering, a
  specific record).

## 2. Isolate

- Narrow the surface: which layer/module/commit? Use `git bisect` for a regression;
  binary-search the input; comment out or stub halves.
- Read the stack trace top-down to the first frame you own. Add targeted logging or
  a breakpoint at the boundary between "known good" and "goes wrong".
- Check the obvious first: recent changes, config/env differences, versions,
  null/empty inputs, off-by-one, wrong assumption about a dependency's behavior.

## 3. Hypothesize & test

- State a specific, falsifiable hypothesis: "X is null here because Y returns early
  when Z."
- Test it directly (a log line, a unit test, an assertion) — confirm the cause before
  fixing. Change one thing at a time so you know what mattered.

## 4. Fix the root cause

- Fix the underlying defect, not just the symptom. If you only mask it, say so.
- Consider sibling cases the same bug affects. Keep the fix minimal and focused.

## 5. Verify

- Re-run the original repro — it must now pass.
- Run the surrounding tests to check you didn't break anything nearby.
- Add a regression test that fails without your fix and passes with it, so it can't
  silently come back.

## Common traps

Async races and unawaited promises; mutable shared state; stale caches; environment
differences; time zones and encodings; error-swallowing `catch` blocks; and assuming
a library does what its name suggests instead of what its docs say.
