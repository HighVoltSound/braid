---
name: braid
description: >
  Code autopilot: does the task with the smallest change, then runs the
  project's real checks, gets a fresh-eyes review, tries to refute every
  finding, fixes what is real (bugs get a failing test first) and repeats
  until clean, at most 3 rounds. Any stack; knows Godot, Unreal and Unity. Use for
  /braid, "braid this", "fix loop", "review and fix".
argument-hint: "[task | files | audit]"
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/checks.js" *)
---

# Braid

You run a closed loop so the human only reads the result: build, check, review, refute, fix, repeat. Executable checks decide. Your opinion of your own code does not.

Request: $ARGUMENTS

## 0. Scope and baseline

- **Mode.** A task: build it (step 1), then loop over your own edits. `turn: <files>` (sent by braid's stop hook): skip step 1 and loop over the edits you made during this turn in those files; only those edits are in scope. Files or a folder: loop over them. `audit`: the whole project; on a big one, start where a mistake costs most (entry points, saves and data, money, security) and say what you skipped. Nothing: the current changes (`git diff HEAD` plus untracked files; without git, the files changed in this session). Nothing changed: say so and stop.
- **The user's own edits.** In task mode, before editing, note which files already have uncommitted changes and save their `git diff`. Later, reviewers get only the hunks you wrote.
- **Project root:** the folder with the project file (`project.godot`, `*.uproject`, `ProjectSettings/ProjectVersion.txt`, `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `*.csproj`, ...) that contains the scoped files.
- **Baseline.** Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/checks.js" "<root>"` now. Every check that passes now is an anchor and must pass at the end. A check that fails now is pre-existing: fix it only if it is in scope; otherwise leave it for the report. In turn mode and for current changes the edits are already on disk, so there is no clean baseline: a failing check is pre-existing only if its error has nothing to do with these edits or the code that calls them; otherwise it is in scope. When step 1 is skipped, this run is round 1's check run; rerun only after an edit.
- **No checks found:** add the smallest test that runs the scoped code, or set `.claude/braid.json` to `{"checks": {"test": "<command>"}}`.
- **SKIP** means a check could not run for a reason outside the code (an open editor, Live Coding, a license, a missing engine). It is neither an anchor nor a failure: name it under Not checked with what it needs.
- **Godot test:** `tests/<name>_test.gd` that `extends SceneTree`. Put the asserts in `func _initialize():` after `await process_frame`, `load()` project scripts (not `preload`), reach autoloads with `root.get_node("Name")`, and end with `quit(0)` on success or `quit(1)` on failure.
- **Unreal test:** `Source/<Module>/Private/Tests/<Name>Test.cpp`, inside `#if WITH_DEV_AUTOMATION_TESTS`: `IMPLEMENT_SIMPLE_AUTOMATION_TEST(F<Name>Test, "<Project>.<Area>.<Name>", EAutomationTestFlags::EditorContext | EAutomationTestFlags::ProductFilter)`, then `bool F<Name>Test::RunTest(const FString&)` with `TestEqual`/`TestTrue`, returning `true`. The first part of the test name is what the checks run.
- **Unity test:** EditMode, in `Assets/Tests/Editor/` with its own asmdef: `references` to the code's asmdef (the code needs one; `Assembly-CSharp` cannot be referenced), `includePlatforms: ["Editor"]`, `defineConstraints: ["UNITY_INCLUDE_TESTS"]`, `overrideReferences: true`, `precompiledReferences: ["nunit.framework.dll"]`, and NUnit `[Test]` methods.

## 1. Build (only for a task)

Smallest complete change, first option that works (ladder adapted from DietrichGebert/ponytail, MIT): does it need to exist; already in the codebase; standard library or engine feature; installed dependency; one clear line; otherwise the minimum code. Reach every place the change must touch: callers, scenes, signals, tests, config. New non-trivial logic gets one small test that the checks run. No abstraction, option or dependency nobody asked for.

Decide instead of asking. If part of the request looks unjustified, build the justified part and record a ruling. Ask the human only before destructive, external or irreversible actions.

## 2. Loop: at most 3 rounds

Each round:

1. **Checks.** Run them all. An anchor turned red or a new failure: read the error, reproduce it, fix the root cause, rerun. Leave pre-existing failures outside the scope alone.
2. **Review.** In one message, spawn three `braid:reviewer` agents in parallel, lenses `correctness`, `risk`, `lean`. Give each:
   - the task in one paragraph;
   - the mode: "diff" (task, turn or current changes) or "whole files, no diff" (files or audit);
   - the project root and the scoped files;
   - how to see the change: `git diff HEAD -- <files>`, only your own hunks in task and turn mode (quote the edited functions when git cannot separate them), or the list of edited files;
   - the latest check summary.

   Do not pass your reasoning: fresh eyes are the point. From round 2, scope them to the files the last round changed, and pass the last findings so they mark each ADDRESSED or NOT and look for new breakage in that diff.
3. **Refute.** In one message, spawn one `braid:skeptic` per must and should finding, with the finding, the task in one line and the root. Keep only CONFIRMED. Drop nice-to-have findings unless they only delete code and are obviously safe.
4. **Fix** confirmed findings, worst first, one at a time:
   - Bug: write a test that fails because of the bug and run it. It must fail for that reason, not for a typo. Then make the smallest root-cause fix in the shared code and rerun every check. If no test can reach it (visuals, feel, hardware), say so in the report.
   - Lean: delete, merge or reuse. Behavior stays the same, and checks stay green.
   - A fix that turns an anchor red: undo your edit (never with a command that also drops the user's uncommitted work) and record a ruling.
   - Never weaken, skip or delete an existing test or assertion to get green, and never silence a check. If a test contradicts the task, stop that item and record a ruling.
5. **Stop** when every anchor is green, nothing new fails, and the round confirmed no must or should finding. From round 2, only must findings keep the loop going; new should findings go to the report as suggestions. A finding confirmed again after its fix means patching is not working: stop that item and record "needs redesign: ...". After round 3, stop.

## 3. Report

Last command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/checks.js" "<root>" --reviewed`, so the stop hook does not ask to review this same code again. Then report in the user's language, short:

- **Changed:** two or three lines.
- **Checks:** each check PASS or FAIL from a fresh run made after the last edit. Never from memory.
- **Fixed:** numbered, one line each, with `path:line`.
- **Rulings:** decisions you made instead of asking, as `what - why - cost if wrong`.
- **Not checked:** one or two lines on what no check covers (visuals, feel, performance on a device), and the pre-existing failures you left.

"Should work" is not evidence. No completion claim without the check output behind it.
