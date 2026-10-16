# Changelog

All notable changes to braid are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-10-16

### Added

- Plugin setting `gate` (`auto`, `fast`, `all`, `off`), set with `/plugin configure braid`. The gate mode now comes from the first of: `BRAID_GATE`, the plugin setting, `.claude/braid.json`, then `auto`.
- `BRAID_CACHE_DIR` sets where braid keeps its state. Without it, braid uses `$XDG_CACHE_HOME/braid`, else `~/.cache/braid`.
- Docs for teams: cost per turn and how to control it, what the hooks execute, the trust model, CI behavior, where state lives, uninstall, FAQ.
- `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `THIRD_PARTY_NOTICES.md`, issue and pull request templates.

### Changed

- In CI (`CI` or `GITHUB_ACTIONS` set) the hooks do nothing unless `BRAID_GATE` is set.
- Gate modes are validated everywhere: `auto`, `fast`, `all`, `off`; `false`, `0` and `no` mean `off`; anything else warns once and acts as `auto`.
- Node.js 20 or later is required.
- English only: the Russian README and the Russian trigger phrases in the skill description are gone.
- The skill no longer triggers on "make it work", which fired too easily.

### Fixed

- Every check the stop hook runs fits its time budget, so the hook never runs past Claude Code's limit; checks are killed with the hook, or with `checks.js`, on SIGTERM/SIGINT.
- Internal errors are shown as one line instead of being swallowed; braid still lets Claude stop.
- State is written atomically (retried briefly on Windows), and old state is pruned: only braid's own files, after 7 or 30 days.
- Windows: programs are never run from the project folder by bare name (the Gradle wrapper runs as `.\gradlew.bat`); Program Files paths come from the environment.
- Unity test results live in the per-user state folder instead of the shared temp folder.

## [0.3.0] - 2026-10-16

### Added

- Unreal Engine 5: `unreal-build` (UnrealBuildTool, also a stop-hook check), `unreal-tests` (Automation tests with the project's prefixes) and `unreal-blueprints` (CompileAllBlueprints over the project's own assets and plugins). The engine is the project's exact version (launcher, source build or `UE_ROOT`); Live Coding, UE4 and too-long paths SKIP with a hint.
- Unity 6: `unity-tests` / `unity-playmode` (`-runTests`, also tests in embedded packages) or `unity-compile`, then `unity-scripts`, a `dotnet` build of the generated solution that is also the stop hook's compile check. While Unity's generated projects lag behind the code, a pass and missing-reference errors SKIP; other compiler errors still fail. The exact editor version only; a missing license or an open editor SKIPs.
- SKIP: a check that cannot run for a reason outside the code never blocks and never counts as a pass.

### Changed

- Failures show each compile error once, or the failed tests with message and `file:line`.
- The stop hook carries its SKIP notes into the review request, and a second request in one turn leaves out what the first one got reviewed.
- Unity's generated `*.csproj` files are not code changes; `csc.rsp` and the package manifest are. A failing full run takes back a green mark.

## [0.2.0] - 2026-10-16

### Added

- Automatic mode: after every turn that changes code, the stop hook runs the fast checks, then asks Claude once to run the braid loop on exactly the files that turn changed (worked out from a per-session snapshot, with or without git). New default gate mode `auto`; `fast`, `all` and `off` remain.
- The skill's `turn:` mode, and `checks.js --reviewed` so the hook does not ask twice for the same code.
- At session start braid gives Claude the lean-coding ladder, unless Ponytail is enabled.

### Fixed

- Turn tracking survives interrupts and turns started by background notifications.
- Projects created mid-turn and code without checks are reviewed.
- Adding a test no longer disables the hook.
- Slow checks are reported as timed out, not failed.

## [0.1.0] - 2026-10-16

### Added

- `/braid:braid` skill: smallest change (Ponytail ladder), real checks, three fresh-context reviewers, a skeptic per finding, test-first fixes, at most 3 rounds, a report with evidence.
- `scripts/checks.js`: detects checks for JS/TS, Deno, Python, Rust, Go, .NET, Gradle/Maven, Swift, Dart/Flutter, Elixir, Ruby, PHP, Make and Godot 4 (headless import, whole-project compile, SceneTree tests, GUT, gdUnit4).
- Stop gate hook: fast checks on code changed during a turn; blocks while they fail, bounded and fail-open.

[1.0.0]: https://github.com/HighVoltSound/braid/compare/v0.3.0...v1.0.0
[0.3.0]: https://github.com/HighVoltSound/braid/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/HighVoltSound/braid/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/HighVoltSound/braid/releases/tag/v0.1.0
