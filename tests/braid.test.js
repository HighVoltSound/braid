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

const { detect, run, fingerprint, findGodot } = require('../scripts/checks.js');
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

test('detect: python uses the locked environment runner', () => {
  const d = tmp();
  write(d, 'pyproject.toml', '[tool.pytest.ini_options]\n[tool.mypy]\n');
  write(d, 'uv.lock', '');
  const cmds = detect(d).map(c => c.cmd);
  assert.ok(cmds.includes('uv run pytest -q') && cmds.includes('uv run mypy .'), cmds.join(' | '));
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
  assert.deepStrictEqual(projects(d), [path.join(d, 'game')]);
});

test('gate: silent when code is unchanged, blocks on a failing check, then lets go', async () => {
  const d = tmp();
  write(d, 'main.js', 'ok\n');
  cfg(d, { lint: lintBad });
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
  write(d, 'main.js', 'bad, typed by the user\n');
  await gate('turn', input);
  assert.strictEqual(await gate('stop', input), null);
});

test('gate: check commands changed during the turn are not run', async () => {
  const d = tmp();
  write(d, 'main.js', 'ok\n');
  cfg(d, { lint: `${node} -e "process.exit(0)"` });
  const input = { cwd: d, session_id: 's5' };
  await gate('turn', input);
  cfg(d, { lint: `${node} -e "require('fs').writeFileSync('ran.txt', 'x'); process.exit(1)"` });
  write(d, 'main.js', 'changed\n');
  const out = await gate('stop', input);
  assert.ok(out && !out.decision && /changed during this turn/.test(out.systemMessage));
  assert.ok(!fs.existsSync(path.join(d, 'ran.txt')));
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
  cfg(d, { lint: `${node} -e "process.exit(1)"` });
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

test('gate: a missing Godot binary does not block', async () => {
  const d = tmp();
  write(d, 'project.godot', 'config_version=5\n');
  write(d, 'main.gd', 'extends Node\n');
  if (detect(d).some(c => !c.missing && c.name === 'godot-import')) return; // a real Godot is on PATH
  const input = { cwd: d, session_id: 's6' };
  await gate('turn', input);
  write(d, 'main.gd', 'extends Node2D\n');
  assert.strictEqual(await gate('stop', input), null);
});
