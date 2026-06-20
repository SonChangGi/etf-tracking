#!/usr/bin/env python3
"""Fail when GitHub-owned workflow actions are not pinned to immutable SHAs."""

from __future__ import annotations

import re
import sys
from pathlib import Path

ACTION_USES_RE = re.compile(r"uses:\s*(actions/[A-Za-z0-9_.-]+)@([^\s#]+)")
SHA_RE = re.compile(r"^[0-9a-f]{40}$")


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    workflow_dir = root / ".github" / "workflows"
    if not workflow_dir.exists():
        print("No .github/workflows directory; nothing to verify.")
        return 0
    failures: list[str] = []
    for path in sorted([*workflow_dir.glob("*.yml"), *workflow_dir.glob("*.yaml")]):
        for line_no, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
            match = ACTION_USES_RE.search(line)
            if not match:
                continue
            action, ref = match.groups()
            if not SHA_RE.match(ref):
                failures.append(f"{path.relative_to(root)}:{line_no}: {action}@{ref} is not pinned to a 40-char SHA")
            if "# v" not in line:
                failures.append(f"{path.relative_to(root)}:{line_no}: pinned action should retain original version comment, e.g. # vN")
    if failures:
        print("\n".join(failures), file=sys.stderr)
        return 1
    print("All GitHub-owned Actions are pinned to immutable SHAs with version comments.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
