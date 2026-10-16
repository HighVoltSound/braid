'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// Everything (temp projects, gate state, fake Godot downloads) lives under one folder that is removed at the end.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-test-'));
process.env.HOME = process.env.USERPROFILE = ROOT;
for (const v of ['CLAUDE_PROJECT_DIR', 'GODOT_BIN', 'GODOT', 'BRAID_GATE']) delete process.env[v];
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 5 }));

const { detect, run, snapshot, fingerprint, findGodot, readState, writeState } = require('../scripts/checks.js');
const { gate, projects } = require('../hooks/gate.js');

const WIN = process.platform === 'win32';
let n = 0;
const tmp = () => { const d = path.join(ROOT, `p${n++}`); fs.mkdirSync(d); return d; };
const write = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
const node = process.execPath.includes(' ') ? `"${process.execPath}"` : process.execPath;
const cfg = (dir, checks, extra = {}) => write(dir, '.claude/braid.json', JSON.stringify({ checks, ...extra }));
// A lint that fails while main.js contains "bad".
const lintBad = `${node} -e "process.exit(require('fs').readFileSync('main.js','utf8').includes('bad') ? 1 : 0)"`;

test('detect: npm scripts, skipping the npm placeholder test', () => {
  const d = tmp();
  write(d, 'package.json', JSON.stringify({ scripts: { lint: 'eslint .', test: 'echo "Error: no test specified" && exit 1' } }));
  assert.deepStrictEqual(detect(d).map(c => c.cmd), ['npm run lint']);
});

test('detect: solution tsconfig uses tsc -b, and a type-check script replaces it', () => {
  const d = tmp();
  write(d, 'package.json', JSON.stringify({ scripts: {} }));
  write(d, 'tsconfig.json', '{ "files": [], "references": [{ "path": "./tsconfig.app.json" }] }');
  write(d, 'node_modules/typescript/package.json', '{}');
  assert.deepStrictEqual(detect(d).map(c => c.cmd), ['npx tsc -b']);
  write(d, 'package.json', JSON.stringify({ scripts: { 'type-check': 'vue-tsc' } }));
  assert.deepStrictEqual(detect(d).map(c => [c.name, c.cmd]), [['type-check', 'npm run type-check']]);
});

test('detect: other stacks by their project files', () => {
  const cases = [
    [{ 'go.mod': 'module x' }, ['go vet ./...', 'go test ./...']],
    [{ 'pom.xml': '<project/>' }, ['mvn -q test']],
    [{ 'gradlew.bat': '', gradlew: '' }, [WIN ? 'gradlew.bat test --quiet' : './gradlew test --quiet']],
    [{ 'Package.swift': '' }, ['swift test']],
    [{ 'mix.exs': '' }, ['mix test']],
    [{ 'deno.json': '{}' }, ['deno lint', 'deno check .', 'deno test -A']],
    [{ 'pubspec.yaml': 'dependencies:\n  flutter:\n    sdk: flutter\n', 'test/a_test.dart': '' }, ['flutter analyze', 'flutter test']],
    [{ 'composer.json': JSON.stringify({ scripts: { test: 'phpunit' } }) }, ['composer test']],
    [{ Gemfile: '', 'spec/a_spec.rb': '' }, ['bundle exec rspec']],
    [{ 'app.csproj': '' }, ['dotnet test --nologo']],
    [{ Makefile: 'test:\n\tcc t.c\n' }, ['make test']],
  ];
  for (const [files, cmds] of cases) {
    const d = tmp();
    for (const [rel, text] of Object.entries(files)) write(d, rel, text);
    assert.deepStrictEqual(detect(d).map(c => c.cmd), cmds, Object.keys(files).join(','));
  }
});

test('detect: engines generate a .sln that is not a .NET test project', () => {
  for (const marker of ['Game.uproject', 'ProjectSettings/ProjectVersion.txt']) {
    const d = tmp();
    write(d, marker, marker.endsWith('.uproject') ? '{"EngineAssociation": "9.9"}' : 'm_EditorVersion: 1.0.0f1\n');
    write(d, 'Game.sln', '');
    const checks = detect(d);
    assert.ok(checks.length && !checks.some(c => c.name === 'dotnet'), JSON.stringify(checks));
  }
});

test('detect: python uses the locked environment runner', () => {
  const d = tmp();
  write(d, 'pyproject.toml', '[tool.pytest.ini_options]\n[tool.mypy]\n');
  write(d, 'uv.lock', '');
  const cmds = detect(d).map(c => c.cmd);
  assert.ok(cmds.includes('uv run pytest -q') && cmds.includes('uv run mypy .'), cmds.join(' | '));
});

test('detect: "skip" in config drops checks by name', () => {
  const d = tmp();
  write(d, 'package.json', JSON.stringify({ scripts: { lint: 'eslint .', test: 'jest' } }));
  cfg(d, undefined, { skip: ['lint'] });
  assert.deepStrictEqual(detect(d).map(c => c.cmd), ['npm run test']);
});

test('detect: config checks replace detection', () => {
  const d = tmp();
  write(d, 'package.json', JSON.stringify({ scripts: { test: 'jest' } }));
  cfg(d, { mine: 'make check' });
  assert.deepStrictEqual(detect(d), [{ name: 'mine', cmd: 'make check' }]);
});

test('detect: godot 4 project with a configured binary and SceneTree tests only', () => {
  const d = tmp();
  write(d, 'project.godot', 'config_version=5\n');
  write(d, 'tests/a_test.gd', 'extends SceneTree\nfunc _init():\n\tquit()\n');
  write(d, 'tests/helper.gd', 'extends Node\n');
  cfg(d, undefined, { godot: process.execPath });
  const names = detect(d).map(c => c.name);
  assert.ok(names.includes('godot-import') && names.includes('godot-scripts'));
  assert.ok(names.includes('godot-test tests/a_test.gd'));
  assert.ok(!names.some(x => x.includes('helper')));
});

test('detect: a Godot 3 project gets no Godot 4 checks', () => {
  const d = tmp();
  write(d, 'project.godot', 'config_version=4\n');
  cfg(d, undefined, { godot: process.execPath });
  assert.ok(!detect(d).some(c => c.name.startsWith('godot')));
});

test('findGodot: prefers the project version and flavor over the newest build', () => {
  const dl = path.join(ROOT, 'Downloads');
  const name = (v, mono) => WIN ? `Godot_v${v}-stable${mono ? '_mono' : ''}_win64.exe` : `Godot_v${v}-stable${mono ? '_mono' : ''}_linux.x86_64`;
  for (const [v, mono] of [['4.2.1', false], ['4.7.2', false], ['4.7.2', true]]) write(dl, `${name(v, mono).replace(/\.exe$/, '')}/${name(v, mono)}`, '');
  if (WIN) write(dl, `${name('4.2.1').replace(/\.exe$/, '')}/${name('4.2.1').replace('.exe', '_console.exe')}`, '');
  const base = p => path.basename(p || '');
  if (spawnSync(WIN ? 'where' : 'which', ['godot']).status === 0) return; // a real godot on PATH wins by design
  assert.strictEqual(base(findGodot(null, { version: '4.2' })), WIN ? 'Godot_v4.2.1-stable_win64_console.exe' : name('4.2.1'));
  assert.strictEqual(base(findGodot(null, { version: '4.9' })), name('4.7.2'));
  assert.strictEqual(base(findGodot(null, { version: '4.7', mono: true })), name('4.7.2', true));
  fs.rmSync(dl, { recursive: true, force: true });
});

test('run: exit code and failOn decide the result', async () => {
  const d = tmp();
  assert.strictEqual((await run({ cmd: `${node} -e "process.exit(0)"` }, d)).ok, true);
  assert.strictEqual((await run({ cmd: `${node} -e "process.exit(2)"` }, d)).ok, false);
  assert.strictEqual((await run({ cmd: `${node} -e "console.log('SCRIPT ERROR: boom')"`, failOn: /SCRIPT ERROR/ }, d)).ok, false);
  assert.strictEqual((await run({ cmd: `${node} -e "process.exit(101)"`, okCodes: [0, 101] }, d)).ok, true);
});

test('run: a hanging process behind a shell is killed soon after its output shows an error', async () => {
  const d = tmp();
  const t = Date.now();
  const r = await run({ cmd: `${node} -e "console.log('SCRIPT ERROR: x'); setInterval(() => {}, 1000)"`, failOn: /SCRIPT ERROR/ }, d);
  assert.strictEqual(r.ok, false);
  assert.ok(Date.now() - t < 10000, 'should not wait for the timeout');
});

test('fingerprint: changes when code changes, ignores docs', () => {
  const d = tmp();
  write(d, 'main.gd', 'extends Node\n');
  write(d, 'README.md', 'a');
  const a = fingerprint(d);
  write(d, 'README.md', 'bb');
  assert.strictEqual(fingerprint(d), a);
  write(d, 'main.gd', 'extends Node2D\n');
  assert.notStrictEqual(fingerprint(d), a);
});

test('snapshot: folders named like engine caches are still walked in other projects', () => {
  const d = tmp();
  write(d, 'Sol.sln', '');
  write(d, 'Library/Parser.cs', 'class P {}\n');
  write(d, 'src/Library/Lib.fs', 'module Lib\n');
  write(d, 'scenes/Content/inv.gd', 'extends Node\n');
  const files = Object.keys(snapshot(d));
  for (const f of ['Library/Parser.cs', 'src/Library/Lib.fs', 'scenes/Content/inv.gd']) assert.ok(files.includes(f), `${f} missing from ${files}`);
});

test('snapshot: Unity and Unreal caches are skipped, their source is not', () => {
  const u = tmp();
  write(u, 'ProjectSettings/ProjectVersion.txt', 'm_EditorVersion: 6000.3.22f1\n');
  write(u, 'Library/Bee/gen.cs', '');
  write(u, 'Assets/Scripts/Player.cs', '');
  write(u, 'Assets/Library/Inv.cs', '');
  assert.deepStrictEqual(Object.keys(snapshot(u)), ['Assets/Library/Inv.cs', 'Assets/Scripts/Player.cs']);
  // A Unity project inside another project keeps its caches out too.
  const outer = tmp();
  write(outer, 'package.json', '{}');
  write(outer, 'game/ProjectSettings/ProjectVersion.txt', 'm_EditorVersion: 6000.3.22f1\n');
  write(outer, 'game/Library/PackageCache/x.cs', '');
  write(outer, 'game/Assets/P.cs', '');
  assert.deepStrictEqual(Object.keys(snapshot(outer)), ['game/Assets/P.cs', 'package.json']);
  // Unreal: Intermediate is a cache; scripts under Content (Python, UnLua) are code; pip packages are not.
  const r = tmp();
  write(r, 'Game.uproject', '{}');
  write(r, 'Intermediate/Build/x.generated.h', '');
  write(r, 'Content/Script/Player.lua', '');
  write(r, 'Content/Python/init_unreal.py', '');
  write(r, 'Content/Python/Lib/site-packages/dep/x.py', '');
  write(r, 'Plugins/Tool/Tool.uplugin', '{}');
  write(r, 'Plugins/Tool/Content/a.py', '');
  write(r, 'Source/Game/Game.cpp', '');
  write(r, 'Config/Windows/WindowsEngine.ini', '');
  assert.deepStrictEqual(Object.keys(snapshot(r)).sort(), ['Config/Windows/WindowsEngine.ini', 'Content/Python/init_unreal.py', 'Content/Script/Player.lua', 'Game.uproject', 'Plugins/Tool/Content/a.py', 'Plugins/Tool/Tool.uplugin', 'Source/Game/Game.cpp']);
});

test('fingerprint: sees non-ASCII paths in a git repo', { skip: spawnSync('git', ['--version']).status !== 0 && 'no git' }, () => {
  const d = tmp();
  spawnSync('git', ['init', '-q'], { cwd: d });
  write(d, 'сцены/игрок.gd', 'extends Node\n');
  const a = fingerprint(d);
  write(d, 'сцены/игрок.gd', 'extends Node2D\n');
  assert.notStrictEqual(fingerprint(d), a);
});

test('projects: finds projects one level down', () => {
  const d = tmp();
  write(d, 'game/package.json', JSON.stringify({ scripts: { lint: 'x' } }));
  write(d, 'notes/a.md', 'x');
  write(d, 'unity/ProjectSettings/ProjectVersion.txt', 'm_EditorVersion: 6000.3.22f1\n');
  write(d, 'unreal/Game.uproject', '{}');
  assert.deepStrictEqual(projects(d).sort(), ['game', 'unity', 'unreal'].map(p => path.join(d, p)));
});

test('gate: silent when code is unchanged, blocks on a failing check, then lets go', async () => {
  const d = tmp();
  write(d, 'main.js', 'ok\n');
  cfg(d, { lint: lintBad }, { gate: 'fast' });
  const input = { cwd: d, session_id: 's1' };
  await gate('turn', input);
  assert.strictEqual(await gate('stop', input), null, 'unchanged code: no checks, no block');

  write(d, 'main.js', 'bad\n');
  const blocked = await gate('stop', input);
  assert.strictEqual(blocked.decision, 'block');
  assert.match(blocked.reason, /FAIL lint/);
  assert.strictEqual(await gate('stop', input), null, 'stopping again without edits is allowed');

  write(d, 'main.js', 'good now\n');
  assert.strictEqual(await gate('stop', input), null, 'green after the fix');
});

test('gate: without a baseline the first stop only records one', async () => {
  const d = tmp();
  write(d, 'main.js', 'bad\n');
  cfg(d, { lint: lintBad });
  assert.strictEqual(await gate('stop', { cwd: d, session_id: 's0' }), null);
});

test('gate: edits made between turns (by the user) do not count', async () => {
  const d = tmp();
  write(d, 'main.js', 'ok\n');
  cfg(d, { lint: lintBad });
  const input = { cwd: d, session_id: 's4' };
  await gate('turn', input);
  assert.strictEqual(await gate('stop', input), null);
  write(d, 'main.js', 'bad, typed by the user\n');
  await gate('turn', input);
  assert.strictEqual(await gate('stop', input), null);
});

test('gate: check commands changed during the turn are not run', async () => {
  const d = tmp();
  write(d, 'main.js', 'ok\n');
  cfg(d, { lint: `${node} -e "process.exit(0)"` }, { gate: 'fast' });
  const input = { cwd: d, session_id: 's5' };
  await gate('turn', input);
  cfg(d, { lint: `${node} -e "require('fs').writeFileSync('ran.txt', 'x'); process.exit(1)"` }, { gate: 'fast' });
  write(d, 'main.js', 'changed\n');
  const out = await gate('stop', input);
  assert.ok(out && !out.decision && /changed during this turn/.test(out.systemMessage));
  assert.ok(!fs.existsSync(path.join(d, 'ran.txt')));
});

test('auto: changed check commands skip the checks but still get the review request', async () => {
  const d = tmp();
  write(d, 'main.js', 'ok\n');
  cfg(d, { lint: `${node} -e "process.exit(0)"` });
  const input = { cwd: d, session_id: 'a5' };
  await gate('turn', input);
  cfg(d, { lint: `${node} -e "require('fs').writeFileSync('ran.txt', 'x'); process.exit(1)"` });
  write(d, 'main.js', 'changed\n');
  assert.match((await gate('stop', input)).reason, /braid autopilot/);
  assert.ok(!fs.existsSync(path.join(d, 'ran.txt')));
});

test('auto: adding a Godot test (not a fast check) keeps the gate on', async () => {
  const d = tmp();
  const fake = path.join(ROOT, WIN ? 'fakegodot.cmd' : 'fakegodot');
  write(ROOT, path.basename(fake), WIN ? '@exit /b 0\r\n' : '#!/bin/sh\nexit 0\n');
  if (!WIN) fs.chmodSync(fake, 0o755);
  write(d, 'project.godot', 'config_version=5\n');
  write(d, 'player.gd', 'extends Node\n');
  cfg(d, undefined, { godot: fake });
  const input = { cwd: d, session_id: 'a6' };
  await gate('turn', input);
  write(d, 'player.gd', 'extends Node2D\n');
  write(d, 'tests/player_test.gd', 'extends SceneTree\nfunc _initialize():\n\tquit(0)\n');
  const out = await gate('stop', input);
  assert.match(out.reason, /braid autopilot.*player\.gd.*player_test\.gd/s);
});

test('gate: off in config disables it', async () => {
  const d = tmp();
  write(d, 'main.js', 'x');
  cfg(d, { lint: `${node} -e "process.exit(1)"` }, { gate: 'off' });
  await gate('turn', { cwd: d, session_id: 's2' });
  write(d, 'main.js', 'y');
  assert.strictEqual(await gate('stop', { cwd: d, session_id: 's2' }), null);
});

test('gate: gives up after three blocks in one turn, and starts over next turn', async () => {
  const d = tmp();
  write(d, 'main.js', '0');
  cfg(d, { lint: `${node} -e "process.exit(1)"` }, { gate: 'fast' });
  const input = { cwd: d, session_id: 's3' };
  await gate('turn', input);
  for (let i = 1; i <= 3; i++) {
    write(d, 'main.js', String(i).repeat(i + 1));
    assert.strictEqual((await gate('stop', input)).decision, 'block');
  }
  write(d, 'main.js', 'final edit');
  const out = await gate('stop', input);
  assert.ok(out && !out.decision && /after 3 tries/.test(out.systemMessage));
  await gate('turn', input);
  write(d, 'main.js', 'next turn edit');
  assert.strictEqual((await gate('stop', input)).decision, 'block');
});

test('auto: after green checks, asks once per turn for the review loop on the files this turn changed', async () => {
  const d = tmp();
  write(d, 'main.js', 'ok\n');
  write(d, 'other.js', 'user wip\n');
  cfg(d, { lint: lintBad });
  const input = { cwd: d, session_id: 'a1' };
  await gate('turn', input);
  write(d, 'main.js', 'changed by Claude\n');
  const out = await gate('stop', input);
  assert.strictEqual(out.decision, 'block');
  assert.match(out.reason, /skill "braid:braid" and args "turn: .*main\.js/);
  assert.doesNotMatch(out.reason, /other\.js/, 'files changed before the turn are not listed');
  write(d, 'main.js', 'fixed during the loop\n');
  assert.strictEqual(await gate('stop', input), null, 'at most one review request per turn');
  await gate('turn', input);
  write(d, 'main.js', 'next turn\n');
  assert.match((await gate('stop', input)).reason, /braid autopilot/);
  assert.strictEqual(await gate('stop', input), null, 'stopping again without edits is allowed');
});

test('auto: a turn started without a prompt (background notification) is reviewed too', async () => {
  const d = tmp();
  write(d, 'main.js', 'ok\n');
  cfg(d, { lint: lintBad });
  const input = { cwd: d, session_id: 'a7' };
  await gate('turn', input);
  write(d, 'main.js', 'turn one\n');
  assert.match((await gate('stop', input)).reason, /braid autopilot/);
  assert.strictEqual(await gate('stop', input), null, 'Claude called it trivial and stopped');
  write(d, 'main.js', 'turn two, no prompt before it\n');
  const out = await gate('stop', input);
  assert.match(out.reason, /braid autopilot/);
  assert.doesNotMatch(out.reason, /other/);
});

test('auto: edits made before an interrupt still count after "continue"', async () => {
  const d = tmp();
  write(d, 'a.js', 'a\n');
  write(d, 'b.js', 'b\n');
  cfg(d, { lint: `${node} -e "process.exit(0)"` });
  const input = { cwd: d, session_id: 'a8' };
  await gate('turn', input);
  write(d, 'a.js', 'a edited, then Esc\n');
  await gate('turn', input); // "continue": no Stop ran in between
  write(d, 'b.js', 'b edited\n');
  assert.match((await gate('stop', input)).reason, /a\.js.*b\.js/s);
});

test('auto: a project created during the turn is checked and reviewed', async () => {
  const d = tmp();
  const input = { cwd: d, session_id: 'a9' };
  await gate('turn', input); // empty folder: no project yet
  write(d, 'package.json', JSON.stringify({ scripts: {} }));
  write(d, 'main.js', 'new app\n');
  assert.match((await gate('stop', input)).reason, /braid autopilot.*main\.js/s);
});

test('auto: code with a project file but no checks is still reviewed', async () => {
  const d = tmp();
  write(d, 'requirements.txt', 'requests\n');
  write(d, 'app.py', 'print(1)\n');
  const input = { cwd: d, session_id: 'a10' };
  await gate('turn', input);
  write(d, 'app.py', 'print(2)\n');
  assert.match((await gate('stop', input)).reason, /braid autopilot.*app\.py/s);
});

test('auto: after three blocks, a fix that turns the checks green still gets reviewed', async () => {
  const d = tmp();
  write(d, 'main.js', 'ok\n');
  cfg(d, { lint: lintBad });
  const input = { cwd: d, session_id: 'a11' };
  await gate('turn', input);
  for (let i = 1; i <= 3; i++) {
    write(d, 'main.js', `bad ${'x'.repeat(i)}\n`);
    assert.match((await gate('stop', input)).reason, /FAIL lint/);
  }
  write(d, 'main.js', 'fixed now\n');
  assert.match((await gate('stop', input)).reason, /braid autopilot/);
});

test('auto: in a folder of projects, a failing project does not use up the other project\'s review', async () => {
  const d = tmp();
  for (const p of ['a', 'b']) { write(d, `${p}/main.js`, 'ok\n'); cfg(path.join(d, p), { lint: lintBad }); }
  const input = { cwd: d, session_id: 'a12' };
  await gate('turn', input);
  write(d, 'a/main.js', 'bad\n');
  write(d, 'b/main.js', 'fine\n');
  assert.match((await gate('stop', input)).reason, /FAIL lint/);
  write(d, 'a/main.js', 'good\n');
  const out = await gate('stop', input);
  assert.ok(out.reason.includes(path.join(d, 'a')) && out.reason.includes(path.join(d, 'b')), out.reason);
});

test('run: a check that only runs out of time is reported as timed out, not failed', async () => {
  const r = await run({ cmd: `${node} -e "setTimeout(() => {}, 5000)"`, timeoutMs: 800 }, tmp());
  assert.strictEqual(r.timedOut, true);
});

test('auto: failing checks come first, the review request after they pass', async () => {
  const d = tmp();
  write(d, 'main.js', 'ok\n');
  cfg(d, { lint: lintBad });
  const input = { cwd: d, session_id: 'a2' };
  await gate('turn', input);
  write(d, 'main.js', 'bad\n');
  assert.match((await gate('stop', input)).reason, /FAIL lint/);
  write(d, 'main.js', 'good\n');
  assert.match((await gate('stop', input)).reason, /braid autopilot/);
});

test('checks.js: a full run that fails takes back the green mark of that code', () => {
  const d = tmp();
  write(d, 'main.js', 'bad\n');
  cfg(d, { lint: lintBad });
  writeState(d, { green: fingerprint(d) });
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'checks.js'), d], { encoding: 'utf8' });
  assert.strictEqual(r.status, 1, r.stdout);
  assert.strictEqual(readState(d).green, undefined);
});

test('auto: code already marked reviewed by checks.js --reviewed is not asked again', async () => {
  const d = tmp();
  write(d, 'main.js', 'ok\n');
  cfg(d, { lint: lintBad });
  const input = { cwd: d, session_id: 'a3' };
  await gate('turn', input);
  write(d, 'main.js', 'reviewed edit\n');
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'checks.js'), d, '--reviewed'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(await gate('stop', input), null);
});

const reviewed = d => {
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'checks.js'), d, '--reviewed'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
};

test('auto: a second request in a turn the user did not end leaves out what the first one got reviewed', async () => {
  const d = tmp();
  for (const f of ['a.js', 'b.js', 'c.js']) write(d, f, '1\n');
  write(d, 'package.json', '{}');
  const input = { cwd: d, session_id: 'a3b' };
  await gate('turn', input);
  write(d, 'a.js', '2\n');
  fs.rmSync(path.join(d, 'c.js'));
  assert.ok((await gate('stop', input)).reason.includes(`${d}: a.js, c.js (deleted).`));
  reviewed(d);
  write(d, 'b.js', '2\n');
  await gate('turn', input); // the user wrote while Claude was still working
  const out = await gate('stop', input);
  assert.ok(out.reason.includes(`${d}: b.js.`), out.reason);
});

test('auto: a --reviewed covers only files a request listed, never another session\'s or a later deletion', async () => {
  const d = tmp();
  for (const f of ['a.js', 'b.js']) write(d, f, '1\n');
  write(d, 'package.json', '{}');
  reviewed(d);
  write(d, 'x.js', 'made by the user after that review\n');
  const a = { cwd: d, session_id: 'a3c' };
  const b = { cwd: d, session_id: 'a3d' };
  await gate('turn', a);
  await gate('turn', b);
  write(d, 'b.js', '2\n');
  fs.rmSync(path.join(d, 'x.js'));
  assert.ok((await gate('stop', a)).reason.includes('x.js (deleted)'));
  reviewed(d);
  write(d, 'a.js', '2\n');
  const out = await gate('stop', b);
  assert.ok(out.reason.includes('b.js') && out.reason.includes('x.js (deleted)'), out.reason);
});

test('start: hands over the ladder unless ponytail is enabled', async () => {
  const d = tmp();
  const out = await gate('context', { cwd: d });
  assert.match(out.hookSpecificOutput.additionalContext, /smallest complete change/);
  write(ROOT, '.claude/settings.json', JSON.stringify({ enabledPlugins: { 'ponytail@ponytail': true } }));
  assert.strictEqual(await gate('context', { cwd: d }), null);
  fs.rmSync(path.join(ROOT, '.claude'), { recursive: true, force: true });
});

test('gate: a missing Godot binary does not block', async () => {
  const d = tmp();
  write(d, 'project.godot', 'config_version=5\n');
  write(d, 'main.gd', 'extends Node\n');
  cfg(d, undefined, { gate: 'fast' });
  if (detect(d).some(c => !c.skip && c.name === 'godot-import')) return; // a real Godot is on PATH
  const input = { cwd: d, session_id: 's6' };
  await gate('turn', input);
  write(d, 'main.gd', 'extends Node2D\n');
  assert.strictEqual(await gate('stop', input), null);
});
