#!/usr/bin/env bash
#
# Re-index the two code graphs after a commit, in the background.
#
# Both of them go stale at exactly one moment — when the tree changes — and
# both were being refreshed by hand, which meant they were refreshed when
# somebody remembered. GitNexus was eight commits behind and graphify was three
# weeks behind the last time anyone looked.
#
# Four things this has to get right, and all four were learned the hard way:
#
#  1. NEVER BLOCK THE COMMIT. post-commit runs inside `git commit`, so anything
#     slow here is felt on every single one. This script re-execs itself
#     detached and returns immediately.
#  2. NEVER RUN TWO AT ONCE. GitNexus's index has been corrupted twice with
#     "FTS index 'file_fts' is inconsistent", each time leaving a quarantined
#     missing-shadow WAL sidecar behind, and concurrent writers are the likeliest
#     cause. The lock below is the point of the whole script.
#  3. SKIP THE STORMS. A 20-commit rebase fires post-commit 20 times, so a
#     rebase in progress is skipped — `post-rewrite` fires once at the end and
#     picks it up. A merge or a cherry-pick produces exactly ONE commit and is
#     NOT skipped; skipping those was a bug, and it meant every merge to main
#     left the index a commit behind.
#  4. NEVER FAIL. A housekeeping script that returns non-zero from a git hook is
#     a scary message after a successful commit. Every path exits 0.
#
# Four hooks call this, because no single one covers every way the tree moves:
# `post-commit` (a commit), `post-merge` (git merge does NOT fire post-commit),
# `post-checkout` (a branch switch changes everything), and `post-rewrite`
# (amend, and the end of a rebase). The lock makes overlapping triggers safe.
#
# Run it by hand any time: `scripts/refresh-graphs.sh`
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCK="$REPO/.gitnexus/.refresh.lock"
LOG="$REPO/.gitnexus/refresh.log"

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG" 2>/dev/null || true; }

# --- 3. mid-operation? leave it alone -------------------------------------
git_dir="$(git -C "$REPO" rev-parse --git-dir 2>/dev/null || echo "$REPO/.git")"
# Only the states that produce a *burst* of commits. MERGE_HEAD and
# CHERRY_PICK_HEAD deliberately absent: one commit each, and they are exactly
# the moments the tree changes most.
for state in rebase-merge rebase-apply BISECT_LOG; do
  if [ -e "$git_dir/$state" ]; then
    log "skipped: $state in progress"
    exit 0
  fi
done

# --- 1. detach, unless we already are -------------------------------------
if [ "${GRAPH_REFRESH_CHILD:-}" != "1" ]; then
  GRAPH_REFRESH_CHILD=1 setsid nohup "$0" "$@" >/dev/null 2>&1 < /dev/null &
  exit 0
fi

# --- 2. one at a time ------------------------------------------------------
mkdir -p "$REPO/.gitnexus" 2>/dev/null || true
if ! mkdir "$LOCK" 2>/dev/null; then
  # A refresh already running will pick up this commit too — it re-reads the
  # tree when it starts. Queuing a second one buys nothing and risks (2).
  log "skipped: a refresh is already running"
  exit 0
fi
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT

COMMIT="$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo unknown)"
log "refreshing at $COMMIT"

# --- GitNexus --------------------------------------------------------------
# `run.cjs` picks an available runner itself; it is what the generated block in
# CLAUDE.md tells a human to use, so the hook uses the same entry point.
if [ -f "$REPO/.gitnexus/run.cjs" ]; then
  if (cd "$REPO" && node .gitnexus/run.cjs analyze >> "$LOG" 2>&1); then
    log "gitnexus ok"
  elif tail -60 "$LOG" | grep -q "FTS index 'file_fts' is inconsistent"; then
    # SELF-HEAL, and the reasoning is that this index is not data.
    #
    # This exact corruption has now happened three times — twice on a manual
    # run and once after four incremental ones — and the remedy has been
    # identical every time. It was left manual at first because `clean --force`
    # sounds destructive. It is not: every node in this index is derived from
    # the tree by `analyze`, so the worst a rebuild costs is a couple of
    # minutes of CPU in a background process nobody is waiting on. Leaving it
    # manual meant the graph silently stopped tracking the code until somebody
    # read a log, which is the failure this whole script exists to end.
    #
    # Once, and only for this message. Any other failure is still reported and
    # left alone, because "delete the index and try again" is not a general
    # answer to an unknown error.
    log "gitnexus FAILED with the known FTS corruption — rebuilding from scratch"
    if (cd "$REPO" \
      && npx --yes gitnexus@latest clean --force --lbug-sidecars >> "$LOG" 2>&1 \
      && npx --yes gitnexus@latest clean --force >> "$LOG" 2>&1 \
      && npx --yes gitnexus@latest analyze >> "$LOG" 2>&1); then
      log "gitnexus rebuilt ok"
    else
      log "gitnexus REBUILD FAILED — needs a human"
    fi
  else
    log "gitnexus FAILED — see the output above this line"
  fi
fi

# --- graphify --------------------------------------------------------------
# `update` is the code-only path. The doc/paper/image half needs an LLM, which
# this hook has no way to reach — it runs headless, from git, with no session.
#
# That does NOT mean an API key is required. The `/graphify` skill dispatches
# Claude Code subagents and uses the host session itself as the model; a key
# (GEMINI_API_KEY) is only the *unattended* alternative. So the honest split is:
# this hook keeps the code half current for free, and the doc half is refreshed
# by running `/graphify --update` in a session. Running the full `--update` here
# would drop those nodes on every commit and shrink the graph silently.
if command -v graphify >/dev/null 2>&1 && [ -d "$REPO/graphify-out" ]; then
  if (cd "$REPO" && graphify update . >> "$LOG" 2>&1); then
    log "graphify ok (code only — run /graphify --update in a session for docs and images)"
  else
    log "graphify FAILED"
  fi
fi

# --- the one vault fact that is pure data ---------------------------------
# Everything else in the vault needs judgment and stays manual. These four
# numbers come straight out of the index and were eight days wrong.
python3 "$REPO/scripts/stamp-index-snapshot.py" >> "$LOG" 2>&1 \
  && log "vault snapshot stamped" || log "vault snapshot skipped"

log "done at $COMMIT"
exit 0
