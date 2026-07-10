---
name: git-workflow
description: Safe, conventional git workflows — branching, staging, commit messages, PRs, rebase vs merge, and recovering from mistakes. Use when the user wants help committing work, opening a pull request, cleaning up history, resolving a conflict, or undoing a git operation safely.
license: MIT (© 2026 Pi Desktop contributors)
---

# Git workflow

Help the user move changes through git safely. Prefer operations that are easy to
undo, and never rewrite shared history without explicit confirmation.

## Ground rules

- Inspect before you act: `git status`, `git diff`, `git log --oneline -10`,
  `git branch --show-current`.
- Never commit or push unless the user asked. If work is on the default branch
  (`main`/`master`), create a topic branch first.
- Never force-push or rebase a branch others may have pulled without saying so
  clearly and getting a yes.
- Don't commit secrets, large binaries, or generated files. Check `git status`
  for surprises before staging with `git add -A`.

## Branch + commit

1. `git switch -c feat/short-topic` (or `fix/…`, `chore/…`).
2. Stage deliberately: `git add -p` to review hunks, or `git add <paths>`.
3. Commit with a clear message:
   - Subject: imperative, ≤ ~72 chars — "Add retry to uploader", not "added retries".
   - Body (optional): what changed and *why*, wrapped ~72 cols.
   - Group related changes; avoid mega-commits that mix unrelated work.

## Pull requests

- Push the branch: `git push -u origin HEAD`.
- Open with the `gh` CLI: `gh pr create --fill` or with an explicit title/body.
- PR body: what + why, how to test, and any risk/rollout notes. Link the issue.

## Rebase vs merge

- **Rebase** a *local, unpushed* branch onto the latest base to keep history linear:
  `git fetch && git rebase origin/main`. Resolve conflicts, `git rebase --continue`.
- **Merge** when the branch is shared, or when preserving the true history matters.
- To update a feature branch without a messy merge bubble, prefer rebase while it's
  still yours alone.

## Conflicts

- `git status` lists conflicted files; edit to resolve the `<<<<<<< ======= >>>>>>>`
  markers, then `git add <file>` and continue the operation.
- Bail out safely any time with `git rebase --abort` / `git merge --abort`.

## Recovery (undo safely)

- Un-stage: `git restore --staged <file>`. Discard working changes: `git restore <file>`
  (destructive — confirm first).
- Amend the last (unpushed) commit: `git commit --amend`.
- Undo the last commit, keep changes: `git reset --soft HEAD~1`.
- Lost a commit? `git reflog` shows recent HEADs; `git switch -c rescue <sha>`.
- Recover an accidentally deleted branch tip via its reflog sha, not a re-do from memory.
