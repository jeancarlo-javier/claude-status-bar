# AGENTS.md

## Versioning

SemVer. `.claude-plugin/plugin.json` `version` and the git tag always match.

- **patch** — fixes, docs, hardening
- **minor** — new user-visible behavior (a segment, a hook, an ack token)
- **major** — an install or config change existing users must act on

Release:

```bash
# bump plugin.json version first, commit, then:
git tag -a vX.Y.Z -m "vX.Y.Z — one line" && git push origin vX.Y.Z
gh release create vX.Y.Z --title "vX.Y.Z — one line" --notes-file <notes>
```

Never move a published tag — cut the next patch instead. Tag `HEAD`, never a commit behind it:
the tarball is what people download.
