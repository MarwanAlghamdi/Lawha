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
#  3. SKIP THE STORMS. A 20-commit rebase fires post-commit 20 times. Mid-rebase,
#     mid-merge and mid-cherry-pick states are detected and skipped; the commit
#     that ends them re-indexes once.
#  4. NEVER FAIL. A housekeeping script that returns non-zero from a git hook is
#     a scary message after a successful commit. Every path exits 0.
#
# Run it by hand any time: `scripts/refresh-graphs.sh --now`
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCK="$REPO/.gitnexus/.refresh.lock"
LOG="$REPO/.gitnexus/refresh.log"

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG" 2>/dev/null || true; }

# --- 3. mid-operation? leave it alone -------------------------------------
git_dir="$(git -C "$REPO" rev-parse --git-dir 2>/dev/null || echo "$REPO/.git")"
for state in rebase-merge rebase-apply MERGE_HEAD CHERRY_PICK_HEAD BISECT_LOG; do
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
  else
    # The known failure is a corrupt FTS index from a quarantined WAL sidecar.
    # Not repaired automatically: `clean --force` throws the index away, and a
    # background hook is the wrong place to decide that. Say what to run.
    log "gitnexus FAILED — if it says \"FTS index 'file_fts' is inconsistent\", run:"
    log "  npx gitnexus@latest clean --force --lbug-sidecars && npx gitnexus@latest analyze"
  fi
fi

# --- graphify --------------------------------------------------------------
# `update` is the code-only path and needs no LLM key. The doc/paper/image half
# needs one; without it those nodes are dropped on every rebuild, so this
# deliberately does NOT run the full `--update` and shrink them silently.
if command -v graphify >/dev/null 2>&1 && [ -d "$REPO/graphify-out" ]; then
  if (cd "$REPO" && graphify update . >> "$LOG" 2>&1); then
    log "graphify ok (code only — set GEMINI_API_KEY and run /graphify --update for docs)"
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
