# Contributing

Thanks for helping. Bug reports with a small repro are the most useful contribution.

## Setup

You need Node.js 20+ and git. There are no npm dependencies.

```
git clone https://github.com/HighVoltSound/braid.git
cd braid
npm test
```

`npm test` runs the unit tests and, when a Godot 4 binary is found (`GODOT_BIN` or PATH), integration tests against generated Godot projects. CI runs them on Linux, Windows and macOS, plus a job with a real Godot build.

To try your copy in Claude Code, start a session with the plugin loaded from the folder:

```
claude --plugin-dir /path/to/braid
```

## Layout

| Path | What it is |
|---|---|
| `skills/braid/SKILL.md` | The loop Claude follows: build, check, review, refute, fix, report |
| `agents/reviewer.md`, `agents/skeptic.md` | The reviewer and skeptic subagents |
| `hooks/gate.js`, `hooks/hooks.json` | The automatic part: snapshots, fast checks, the review request |
| `scripts/checks.js` | Finds and runs a project's checks |
| `scripts/engines.js` | Unreal and Unity checks |
| `scripts/godot_check.gd` | Compiles every Godot script and scene |
| `tests/` | `node --test` suites |

## Style

- Small changes. One fix or feature per pull request.
- Every bug fix comes with a test that fails without it.
- Plain Node, no dependencies. Keep the hook fast and fail-open: an error inside it must let Claude stop.
- Never run a command the project did not define.
- Docs in plain English, short sentences. Update `README.md` and `CHANGELOG.md` when behavior changes.

## Adding checks for a stack

1. Detection lives in `found()` in `scripts/checks.js` (engines in `scripts/engines.js`). Detect from files the stack always has (`Cargo.toml`, `go.mod`, ...), and add a check with `add(name, command)`.
2. Use the stack's own commands. Prefer the project's locked tool runner when there is one (as Python does with `uv run` / `poetry run`).
3. A cheap check (types, lint, compile) can run in the stop hook: add its name to `FAST` in `scripts/checks.js`. Tests and slow builds stay out of it.
4. When a tool can be missing or busy (an engine, a license, an open editor), report SKIP with what it needs instead of failing.
5. If the stack has new source extensions or project files, add them to `CODE` so changes to them count, and to `MARKERS` in `hooks/gate.js` if they mark a project root.
6. Add tests in `tests/` that build a tiny project in a temp folder and assert the detected checks.
7. Add a row to "Checks it finds by itself" in the README.

## Reporting bugs

Use the bug report form. Include the hook output (the "braid gate:" or "braid autopilot:" message) and the output of `node <plugin>/scripts/checks.js <project> --list`.

By contributing you agree that your work is released under the [MIT License](LICENSE), and to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
