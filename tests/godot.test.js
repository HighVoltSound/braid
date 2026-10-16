'use strict';
// Runs the Godot checks against small generated projects. Skipped when no Godot binary is found.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { detect, run, findGodot } = require('../scripts/checks.js');

const godot = findGodot();
const opts = { skip: godot ? false : 'no Godot binary found', timeout: 240000 };
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-godot-'));
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 5 }));
let n = 0;

function project(files) {
  const d = path.join(ROOT, `p${n++}`);
  const all = { 'project.godot': 'config_version=5\n\n[application]\nconfig/name="t"\n', ...files };
  for (const [rel, text] of Object.entries(all)) {
    fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true });
    fs.writeFileSync(path.join(d, rel), text);
  }
  return d;
}

async function results(d) {
  const out = {};
  for (const c of detect(d)) out[c.name] = await run(c, d);
  return out;
}

const GOOD = 'extends Node\n\nfunc add(a: int, b: int) -> int:\n\treturn a + b\n';

test('clean project with an autoload and class_name passes', opts, async () => {
  const d = project({
    'project.godot': 'config_version=5\n\n[application]\nconfig/name="t"\n\n[autoload]\nGlobals="*res://globals.gd"\n',
    'globals.gd': 'extends Node\nvar value := 3\n',
    'util.gd': 'class_name Util\nextends RefCounted\nstatic func twice(x: int) -> int:\n\treturn x * 2\n',
    'uses.gd': 'extends Node\nfunc f() -> int:\n\treturn Util.twice(Globals.value)\n',
    'tests/util_test.gd': 'extends SceneTree\nfunc _init() -> void:\n\tquit(0 if Util.twice(2) == 4 else 1)\n',
  });
  const r = await results(d);
  for (const [name, res] of Object.entries(r)) assert.ok(res.ok, `${name} failed:\n${res.out}`);
});

test('parse error in a script nothing references fails godot-scripts', opts, async () => {
  const r = await results(project({ 'good.gd': GOOD, 'orphan.gd': 'extends Node\nfunc x(\n' }));
  assert.strictEqual(r['godot-scripts'].ok, false);
  assert.match(r['godot-scripts'].out, /orphan\.gd/);
});

test('type error fails godot-scripts', opts, async () => {
  const r = await results(project({ 'bad.gd': 'extends Node\nvar x: int = "text"\n' }));
  assert.strictEqual(r['godot-scripts'].ok, false);
});

test('scene pointing at a missing script fails', opts, async () => {
  const scene = '[gd_scene load_steps=2 format=3]\n\n[ext_resource type="Script" path="res://missing.gd" id="1"]\n\n[node name="Root" type="Node"]\nscript = ExtResource("1")\n';
  const r = await results(project({ 'main.tscn': scene }));
  assert.ok(!r['godot-import'].ok || !r['godot-scripts'].ok);
});

test('runtime error in a test fails fast instead of hanging', opts, async () => {
  const t = Date.now();
  const r = await results(project({ 'tests/boom_test.gd': 'extends SceneTree\nfunc _init() -> void:\n\tvar d = null\n\tprint(d.size())\n\tquit(0)\n' }));
  assert.strictEqual(r['godot-test tests/boom_test.gd'].ok, false);
  assert.ok(Date.now() - t < 60000);
});

test('push_error in a test fails it', opts, async () => {
  const r = await results(project({ 'tests/err_test.gd': 'extends SceneTree\nfunc _init() -> void:\n\tpush_error("bad state")\n\tquit(0)\n' }));
  assert.strictEqual(r['godot-test tests/err_test.gd'].ok, false);
});

test('folders with .gdignore are skipped, as Godot does', opts, async () => {
  const r = await results(project({ 'good.gd': GOOD, 'docs/.gdignore': '', 'docs/snippet.gd': 'extends Node\nfunc x(\n' }));
  assert.ok(r['godot-scripts'].ok, r['godot-scripts'].out);
});

test('the SKILL.md test template works with autoloads', opts, async () => {
  const r = await results(project({
    'project.godot': 'config_version=5\n\n[application]\nconfig/name="t"\n\n[autoload]\nGlobals="*res://globals.gd"\n',
    'globals.gd': 'extends Node\nvar value := 3\n',
    'calc.gd': 'extends RefCounted\nfunc triple() -> int:\n\treturn Globals.value * 3\n',
    'tests/calc_test.gd': 'extends SceneTree\n\nfunc _initialize() -> void:\n\tawait process_frame\n\tvar calc = load("res://calc.gd").new()\n\tvar ok: bool = calc.triple() == 9 and root.get_node("Globals").value == 3\n\tquit(0 if ok else 1)\n',
  }));
  assert.ok(r['godot-test tests/calc_test.gd'].ok, r['godot-test tests/calc_test.gd'].out);
});

test('a test that quits with 1 fails', opts, async () => {
  const r = await results(project({ 'tests/fail_test.gd': 'extends SceneTree\nfunc _init() -> void:\n\tquit(1)\n' }));
  assert.strictEqual(r['godot-test tests/fail_test.gd'].ok, false);
});
