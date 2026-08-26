#!/usr/bin/env python3
"""Copy the GitNexus index's own numbers into the vault's snapshot note.

The only part of the knowledge vault worth automating. `doc-002-gitnexus-index-
snapshot.md` is a table of counts that exist verbatim in `.gitnexus/meta.json`,
and it sat eight days and nine hundred symbols out of date because refreshing it
was somebody's job to remember.

Everything else in that vault is judgment — that invariant 10's divergence count
had been wrong since ADR 0028, that knowledge-011's headline gap had been closed,
that this run deserved a note of its own — and none of it can be derived from a
commit. This script deliberately touches four table rows and stops.

Exits 0 when there is nothing to do (no vault, no index, no change) so a git hook
never reports a problem it does not have. Prints only when it writes.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
META = REPO / ".gitnexus" / "meta.json"
NOTE = (
    REPO.parent
    / "Research"
    / "lawha"
    / "Sources"
    / "Docs"
    / "doc-002-gitnexus-index-snapshot.md"
)

# Table label -> how to read it out of meta.json, and how to render it.
ROWS = {
    "Files": lambda m: f"{m['stats']['files']:,}",
    "Symbols": lambda m: f"{m['stats']['nodes']:,}",
    "Relationships": lambda m: f"{m['stats']['edges']:,}",
    "Communities": lambda m: f"{m['stats']['communities']:,}",
    "Execution flows": lambda m: f"{m['stats']['processes']:,}",
    "Indexed commit": lambda m: f"`{m['lastCommit'][:8]}`",
    "Re-indexed": lambda m: m["indexedAt"][:10],
}


def main() -> int:
    if not META.exists() or not NOTE.exists():
        return 0

    try:
        meta = json.loads(META.read_text(encoding="utf-8"))
        text = NOTE.read_text(encoding="utf-8")
    except (OSError, ValueError, KeyError):
        return 0

    changed: list[str] = []
    for label, render in ROWS.items():
        try:
            value = render(meta)
        except (KeyError, TypeError):
            continue

        # `| Label | value |`, whatever the current value is. Anchored on the
        # label so a row that has been reworded by hand is left alone rather
        # than half-rewritten.
        pattern = re.compile(
            rf"^\|\s*{re.escape(label)}\s*\|\s*(.*?)\s*\|\s*$", re.MULTILINE
        )
        match = pattern.search(text)
        if not match or match.group(1) == value:
            continue

        text = pattern.sub(f"| {label} | {value} |", text, count=1)
        changed.append(f"{label}: {match.group(1)} -> {value}")

    if not changed:
        return 0

    NOTE.write_text(text, encoding="utf-8")
    print(f"stamped {NOTE.name}: " + "; ".join(changed))
    return 0


if __name__ == "__main__":
    sys.exit(main())
