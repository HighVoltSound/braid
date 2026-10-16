# Security policy

## Supported versions

| Version | Supported |
|---|---|
| 1.x | yes |
| < 1.0 | no |

Fixes go into the latest release. Update with `claude plugin update braid@braid` (or **Update now** on the plugin in `/plugin`); the new version loads in the next session.

## Reporting a vulnerability

Report it privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability** ([direct link](https://github.com/HighVoltSound/braid/security/advisories/new)). Please do not open a public issue.

Include the braid version, your OS and Claude Code version, and the smallest project or steps that show the problem. The maintainer aims to answer within 7 days. A fix and an advisory follow once the issue is confirmed.

## Trust model in brief

- braid's hooks run `node hooks/gate.js` on session start, on each prompt and when Claude stops.
- On stop, braid runs the check commands the project defines or implies: `package.json` scripts, `.claude/braid.json` entries, a Godot import (which runs editor plugins), an Unreal build (`*.Build.cs`), Unity batch mode (editor scripts), `dotnet build`. That is code from the checkout. Use braid only on code you trust, as you would with `npm test`.
- If those check commands change during a turn, the hook does not run them.
- braid makes no network calls of its own and sends no telemetry. Its state is small JSON files in `$BRAID_CACHE_DIR`, `$XDG_CACHE_HOME/braid` or `~/.cache/braid`, holding file names, sizes and modification times, never file contents.
- In CI (`CI` or `GITHUB_ACTIONS` set) the hooks do nothing unless `BRAID_GATE` is set.

In scope: anything that makes braid run a command the project did not define, write outside the project and its cache folder, or leak data. Out of scope: what a project's own check commands do once you chose to trust that project.
