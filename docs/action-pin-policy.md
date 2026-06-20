# GitHub Actions pinning policy

This project pins GitHub-owned workflow actions to immutable 40-character commit SHAs and keeps the resolved major-version tag as an inline comment (for example `# v6`).

Why this exists:
- Major-version tags are convenient but mutable.
- SHA pinning makes CI/deploy behavior reproducible and reviewable.
- The comment preserves upgrade intent so future updates can intentionally resolve a newer tag and review the diff.

Validation:

```bash
python scripts/verify_actions_pinning.py
```

When upgrading an action, resolve the new tag with `git ls-remote https://github.com/actions/<name>.git refs/tags/vN^{}` and replace only after reading release notes for breaking changes.
