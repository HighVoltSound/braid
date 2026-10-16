'use strict';
// Unreal and Unity detection with fake engines in temp folders (no real engine needed).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-eng-'));
process.env.HOME = process.env.USERPROFILE = ROOT;
for (const v of ['CLAUDE_PROJECT_DIR', 'GODOT_BIN', 'GODOT', 'BRAID_GATE', 'UE_ROOT', 'UNITY_BIN', 'CI', 'GITHUB_ACTIONS', 'CLAUDE_PLUGIN_OPTION_GATE', 'BRAID_CACHE_DIR', 'XDG_CACHE_HOME']) delete process.env[v];
process.env.TMPDIR = process.env.TEMP = process.env.TMP = ROOT;
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 5 }));

const { detect, run, runAfter, config, snapshot } = require('../scripts/checks.js');
const { findUnreal, findUnity, testPrefixes, assetPaths, unityChecks, stateFile } = require('../scripts/engines.js');
const { gate } = require('../hooks/gate.js');

const WIN = process.platform === 'win32';
let n = 0;
const tmp = () => { const d = path.join(ROOT, `p${n++}`); fs.mkdirSync(d); return d; };
const write = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
const node = process.execPath.includes(' ') ? `"${process.execPath}"` : process.execPath;

// A fake engine root whose Build.bat/Build.sh prints `buildOutput` and exits with `code`.
function fakeUnreal(version, buildOutput = 'Result: Succeeded', code = 0) {
  const e = tmp();
  const [major, minor] = version.split('.').map(Number);
  write(e, 'Engine/Build/Build.version', JSON.stringify({ MajorVersion: major, MinorVersion: minor }));
  if (WIN) write(e, 'Engine/Build/BatchFiles/Build.bat', `@echo ${buildOutput}\r\n@exit /b ${code}\r\n`);
  else for (const p of ['Mac', 'Linux']) { write(e, `Engine/Build/BatchFiles/${p}/Build.sh`, `#!/bin/sh\necho "${buildOutput}"\nexit ${code}\n`); fs.chmodSync(path.join(e, `Engine/Build/BatchFiles/${p}/Build.sh`), 0o755); }
  return e;
}
function unrealProject(assoc) {
  const d = tmp();
  write(d, 'Game.uproject', JSON.stringify({ EngineAssociation: assoc }));
  write(d, 'Source/GameEditor.Target.cs', 'public class GameEditorTarget : TargetRules { public GameEditorTarget(TargetInfo T) : base(T) { Type = TargetType.Editor; } }');
  write(d, 'Source/Game/Game.cpp', '// game\n');
  return d;
}

test('findUnreal: a version association must match the engine\'s Build.version', () => {
  const e = fakeUnreal('9.7');
  const d = tmp();
  assert.strictEqual(findUnreal(e, '9.7', d), e);
  assert.notStrictEqual(findUnreal(e, '9.8', d), e);
});

test('findUnreal: UE_ROOT does not beat the engine source tree around the project', () => {
  const tree = fakeUnreal('9.6');
  const d = path.join(tree, 'Projects', 'Game');
  fs.mkdirSync(d, { recursive: true });
  process.env.UE_ROOT = fakeUnreal('9.5');
  try { assert.strictEqual(findUnreal(undefined, '', d), tree); } finally { delete process.env.UE_ROOT; }
});

test('findUnity: a configured or UNITY_BIN editor of another version is never used', () => {
  const other = path.join(tmp(), '2022.3.10f1', 'Editor', WIN ? 'Unity.exe' : 'Unity');
  write(path.dirname(other), path.basename(other), '');
  // (A real 6000.3.22f1 in the Hub may still be found: only the other version must never be.)
  assert.notStrictEqual(findUnity(other, '6000.3.22f1'), other);
  process.env.UNITY_BIN = other;
  try { assert.notStrictEqual(findUnity(undefined, '6000.3.22f1'), other); } finally { delete process.env.UNITY_BIN; }
  assert.strictEqual(findUnity(other, '2022.3.10f1'), other);
});

test('findUnity, findUnreal: Program Files comes from the environment', { skip: !WIN && 'Windows only' }, () => {
  const pf = tmp();
  const exe = path.join(pf, 'Unity', 'Hub', 'Editor', '1.2.3f1', 'Editor', 'Unity.exe');
  write(path.dirname(exe), 'Unity.exe', '');
  const ue = path.join(pf, 'Epic Games', 'UE_9.4');
  write(ue, 'Engine/Build/Build.version', JSON.stringify({ MajorVersion: 9, MinorVersion: 4 }));
  const old = process.env.ProgramFiles;
  process.env.ProgramFiles = pf;
  try {
    assert.strictEqual(findUnity(undefined, '1.2.3f1'), exe);
    assert.strictEqual(findUnreal(undefined, '9.4', tmp()), ue);
  } finally { process.env.ProgramFiles = old; }
});

test('stateFile: BRAID_CACHE_DIR, else an absolute XDG_CACHE_HOME, else ~/.cache', () => {
  const at = () => path.dirname(stateFile(tmp()));
  assert.strictEqual(at(), path.join(ROOT, '.cache', 'braid'));
  process.env.XDG_CACHE_HOME = 'relative/cache';
  assert.strictEqual(at(), path.join(ROOT, '.cache', 'braid'), 'a relative XDG path is ignored');
  process.env.XDG_CACHE_HOME = path.join(ROOT, 'xdg');
  assert.strictEqual(at(), path.join(ROOT, 'xdg', 'braid'));
  process.env.BRAID_CACHE_DIR = path.join(ROOT, 'mine');
  try { assert.strictEqual(at(), path.join(ROOT, 'mine')); } finally { delete process.env.XDG_CACHE_HOME; delete process.env.BRAID_CACHE_DIR; }
});

test('unreal: plugins are found at any depth and mounted by their .uplugin name', () => {
  const d = tmp();
  write(d, 'Content/UI/Library/WBP_X.uasset', '');
  write(d, 'Plugins/GameFeatures/ShooterCore/ShooterCore.uplugin', '{"MarketplaceURL": ""}');
  write(d, 'Plugins/GameFeatures/ShooterCore/Content/B_Gun.uasset', '');
  write(d, 'Plugins/GameFeatures/ShooterCore/Source/Shooter/Private/T.cpp', 'IMPLEMENT_SIMPLE_AUTOMATION_TEST(FT, "Shooter.X", 0)');
  write(d, 'Plugins/GameFeatures/Market/Market.uplugin', '{"MarketplaceURL": "com.epicgames.launcher://ue/marketplace/x"}');
  write(d, 'Plugins/GameFeatures/Market/Source/M/T.cpp', 'IMPLEMENT_SIMPLE_AUTOMATION_TEST(FM, "Market.X", 0)');
  write(d, 'Plugins/MyTools_v2/MyTools.uplugin', '{}');
  write(d, 'Plugins/MyTools_v2/Content/B_Tool.uasset', '');
  write(d, 'Source/Game/Temp/T.cpp', 'IMPLEMENT_SIMPLE_AUTOMATION_TEST(FG, "Game.T", 0)');
  const assets = assetPaths(d);
  for (const a of ['/Game/UI/Library/WBP_X.WBP_X', '/ShooterCore/B_Gun.B_Gun', '/MyTools/B_Tool.B_Tool']) assert.ok(assets.includes(a), `${a} missing from ${assets}`);
  assert.deepStrictEqual(testPrefixes(d).sort(), ['Game', 'Shooter']);
});

test('unreal: spec files give only their own prefix, and nothing that could break -ExecCmds', () => {
  const d = tmp();
  write(d, 'Source/Game/My.spec.cpp', 'BEGIN_DEFINE_SPEC(FMySpec, "Game.MySpec", 0)\nEND_DEFINE_SPEC(FMySpec)\nvoid FMySpec::Define() { Describe("a; Quit", [this]() {}); }\n');
  assert.deepStrictEqual(testPrefixes(d), ['Game']);
});

test('unreal: UE4 projects SKIP instead of failing on missing UE5 binaries', () => {
  const d = unrealProject('4.27');
  write(d, '.claude/braid.json', JSON.stringify({ unrealEngine: fakeUnreal('4.27') }));
  const checks = detect(d);
  assert.strictEqual(checks.length, 1);
  assert.match(checks[0].skip, /Unreal Engine 5/);
});

test('unreal: Live Coding output makes the build SKIP, and the stop hook says so', async () => {
  const d = unrealProject('9.4');
  const engine = fakeUnreal('9.4', 'Unable to build while Live Coding is active. Exit the editor', 6);
  write(d, '.claude/braid.json', JSON.stringify({ unrealEngine: engine, gate: 'fast' }));
  const build = detect(d).find(c => c.name === 'unreal-build');
  const r = await run(build, d);
  assert.ok(r.ok && /Live Coding/.test(r.skipped), JSON.stringify(r));
  const input = { cwd: d, session_id: 'e1' };
  await gate('turn', input);
  write(d, 'Source/Game/Game.cpp', '// edited\n');
  const out = await gate('stop', input);
  assert.ok(out && !out.decision && /SKIP unreal-build/.test(out.systemMessage), JSON.stringify(out));
  // In auto mode the same stop asks for a review: the note goes with it, so Claude knows the build did not run.
  write(d, '.claude/braid.json', JSON.stringify({ unrealEngine: engine }));
  await gate('turn', input);
  write(d, 'Source/Game/Game.cpp', '// edited again\n');
  const review = await gate('stop', input);
  assert.ok(/braid autopilot/.test(review.reason) && /SKIP unreal-build/.test(review.reason), JSON.stringify(review));
});

// A Unity project with a fake editor of its exact version (configured through "unity").
function unityProject() {
  const d = tmp();
  write(d, 'ProjectSettings/ProjectVersion.txt', 'm_EditorVersion: 6000.0.1f1\n');
  const exe = path.join(tmp(), '6000.0.1f1', 'Editor', WIN ? 'Unity.exe' : 'Unity');
  write(path.dirname(exe), path.basename(exe), '');
  return { d, cfg: { unity: exe } };
}
// unity-scripts' verdict on a dotnet build that passed (no output) or failed with `out`.
function judge(d, cfg, out = null) {
  const c = unityChecks(d, cfg, () => 'dotnet').find(x => x.name === 'unity-scripts');
  assert.strictEqual(c.prepare(), null);
  return c.after({ ok: out === null, out: out || '', secs: 0, status: out === null ? 0 : 1 });
}
// What a braid Unity run that compiled the project leaves behind. File times can be as coarse as 16 ms, so it
// waits on each side: the files written before it are older, those written after are newer.
const tick = () => { const t = Date.now() + 30; while (Date.now() < t); };
const unityCompiled = (d, cfg) => {
  tick();
  const c = unityChecks(d, cfg, () => null).find(x => /^unity-(tests|playmode|compile)$/.test(x.name));
  c.prepare();
  c.after({ ok: true, out: '', secs: 0, status: 0 });
  tick();
};

test('unity: a passing build SKIPs while Unity\'s projects miss scripts, and an error in the code still fails', () => {
  const d = tmp();
  write(d, 'ProjectSettings/ProjectVersion.txt', 'm_EditorVersion: 1.0.0f1\n');
  write(d, 'Game.sln', '"Assembly-CSharp.csproj"');
  write(d, 'Assembly-CSharp.csproj', '<Project><ItemGroup><Compile Include="Assets\\A.cs" /></ItemGroup></Project>');
  write(d, 'Assets/A.cs', '');
  assert.ok(!judge(d, {}).skipped);
  write(d, 'Assets/B.cs', '');
  assert.match(judge(d, {}).skipped, /out of date/);
  assert.strictEqual(judge(d, {}, 'B.cs(1,1): error CS1002: ; expected').ok, false, 'a syntax error is in the code whatever the projects say');
  assert.match(judge(d, {}, 'A.cs(1,1): error CS0246: B not found').skipped, /out of date/);
  fs.rmSync(path.join(d, 'Assets/B.cs'));
  write(d, 'Assets/Hidden~/C.cs', '');
  write(d, 'Assets/._A.cs', '');
  write(d, 'Assets/StreamingAssets/S.cs', '');
  assert.ok(!judge(d, {}).skipped, 'Unity ignores "~" folders, hidden files and StreamingAssets');
  write(d, 'Assets/Scripts/Saved/S.cs', '');
  assert.match(judge(d, {}).skipped, /out of date/, 'a folder named Saved under Assets holds real scripts');
  fs.rmSync(path.join(d, 'Assets/Scripts'), { recursive: true });
  fs.rmSync(path.join(d, 'Assets/A.cs'));
  assert.match(judge(d, {}).skipped, /out of date/, 'a listed script that was deleted');
});

test('unity: an asmdef change puts the projects behind until Unity regenerates them or a braid Unity run compiles', () => {
  const { d, cfg } = unityProject();
  write(d, 'Assets/A.cs', '');
  write(d, 'Assets/Vendor/V.asmdef', '{"name": "V", "defineConstraints": ["DOTWEEN"]}');
  write(d, 'Assets/Vendor/T.cs', '');
  write(d, 'Packages/com.me.core/Runtime/Core.asmdef', '{"name": "Core"}');
  write(d, 'Packages/com.me.core/Runtime/P.cs', '');
  tick(); // Unity wrote its projects after the asmdefs
  write(d, 'Assembly-CSharp.csproj', '<Compile Include="Assets\\A.cs" />');
  write(d, 'Core.csproj', '<Compile Include="Packages\\com.me.core\\Runtime\\P.cs" />');
  write(d, 'Game.sln', '"Assembly-CSharp.csproj" "Core.csproj"');
  assert.ok(!judge(d, cfg).skipped, 'an assembly the editor does not build has no project, and that is not staleness');
  write(d, 'Packages/com.me.core/Runtime/Q.cs', '');
  assert.match(judge(d, cfg).skipped, /out of date/, 'a new script in a package that has a project');
  fs.rmSync(path.join(d, 'Packages/com.me.core/Runtime/Q.cs'));
  write(d, 'Assets/AndroidOnly/X.asmdef', '{"name": "X", "includePlatforms": ["Android"]}');
  write(d, 'Assets/AndroidOnly/X.cs', '');
  assert.match(judge(d, cfg).skipped, /assembly definitions/, 'a new assembly: Unity has not seen it yet');
  assert.match(judge(d, cfg, 'A.cs(1,1): error CS0103: X does not exist').skipped, /assembly definitions/);
  assert.strictEqual(judge(d, cfg, 'A.cs(1,1): error CS0029: cannot convert').ok, false);
  unityCompiled(d, cfg); // Unity rewrote no csproj: the new assembly is one the editor does not build
  assert.ok(!judge(d, cfg).skipped);
  assert.strictEqual(judge(d, cfg, 'A.cs(1,1): error CS0103: X does not exist').ok, false, 'a missing name is a real error again');
});

test('unity: the first embedded package puts the projects behind, and so do edits to a package without a project', () => {
  const { d, cfg } = unityProject();
  write(d, 'Assets/A.cs', '');
  write(d, 'Assembly-CSharp.csproj', '<Compile Include="Assets\\A.cs" />');
  write(d, 'Game.sln', '"Assembly-CSharp.csproj"');
  tick();
  write(d, 'Packages/com.me.core/Runtime/Core.asmdef', '{"name": "Core"}');
  write(d, 'Packages/com.me.core/Runtime/P.cs', 'broken');
  assert.match(judge(d, cfg).skipped, /assembly definitions/, 'dotnet never compiled the package');
  assert.match(judge(d, cfg, 'A.cs(1,1): error CS0246: Core not found').skipped, /assembly definitions/, 'correct code that uses the package');
  unityCompiled(d, cfg); // the IDE integration generates no projects for embedded packages here
  assert.ok(!judge(d, cfg).skipped);
  tick(); // that check recorded the projects as current
  write(d, 'Packages/com.me.core/Runtime/P.cs', 'edited');
  assert.match(judge(d, cfg).skipped, /assembly definitions/, 'Assets code compiles against the package DLL of Unity\'s last build');
  tick();
  write(d, 'Assembly-CSharp.csproj', '<Compile Include="Assets\\A.cs" /><Compile Include="Assets\\A.cs" />');
  assert.match(judge(d, cfg).skipped, /assembly definitions/, 'a project Unity rewrote since is no sign the package DLL was rebuilt');
  write(d, 'Packages/com.me.core/Runtime/Extra/Q.cs', '');
  unityCompiled(d, cfg);
  fs.rmSync(path.join(d, 'Packages/com.me.core/Runtime/Extra/Q.cs'));
  assert.match(judge(d, cfg).skipped, /assembly definitions/, 'a package script deleted: its folder changed');
  unityCompiled(d, cfg);
  fs.rmSync(path.join(d, 'Packages/com.me.core/Runtime/Core.asmdef'));
  assert.match(judge(d, cfg).skipped, /assembly definitions/, 'a recorded asmdef deleted');
});

test('unity: an asmdef deleted, moved or copied in with its old file times makes the projects out of date', () => {
  const { d, cfg } = unityProject();
  write(d, 'Assets/A.cs', '');
  write(d, 'Assets/Lib/Lib.asmdef', '{"name": "Lib"}');
  write(d, 'Assets/Lib/L.cs', '');
  write(d, 'Assets/Lib/._Lib.asmdef', '\0junk'); // a macOS copy: Unity skips hidden files
  write(d, 'Assembly-CSharp.csproj', '<AssemblyName>Assembly-CSharp</AssemblyName><Compile Include="Assets\\A.cs" />');
  write(d, 'Lib.csproj', '<AssemblyName>Lib</AssemblyName><Compile Include="Assets\\Lib\\L.cs" />');
  write(d, 'Game.sln', '"Assembly-CSharp.csproj" "Lib.csproj"');
  unityCompiled(d, cfg);
  assert.ok(!judge(d, cfg).skipped);
  fs.mkdirSync(path.join(d, 'Assets/Lib/Deep'));
  fs.renameSync(path.join(d, 'Assets/Lib/Lib.asmdef'), path.join(d, 'Assets/Lib/Deep/Lib.asmdef'));
  assert.match(judge(d, cfg).skipped, /out of date.*Assets\/Lib\/L\.cs/, 'moved: L.cs now compiles into Assembly-CSharp');
  fs.rmSync(path.join(d, 'Assets/Lib/Deep'), { recursive: true });
  assert.match(judge(d, cfg).skipped, /out of date/, 'deleted');
  write(d, 'Assets/Lib/Lib.asmdef', '{"name": "Lib"}');
  unityCompiled(d, cfg);
  const pkg = path.join(tmp(), 'com.me.old');
  write(pkg, 'Runtime/Old.asmdef', '{"name": "Old"}');
  write(pkg, 'Runtime/O.cs', 'broken');
  const t = new Date(Date.now() - 3600000);
  for (const f of ['Runtime/Old.asmdef', 'Runtime/O.cs']) fs.utimesSync(path.join(pkg, f), t, t);
  write(d, 'Packages/com.me.core/Runtime/Core.asmdef', '{"name": "Core"}');
  write(d, 'Packages/com.me.core/Runtime/P.cs', '');
  write(d, 'Core.csproj', '<AssemblyName>Core</AssemblyName><Compile Include="Packages\\com.me.core\\Runtime\\P.cs" />');
  write(d, 'Game.sln', '"Assembly-CSharp.csproj" "Lib.csproj" "Core.csproj"');
  unityCompiled(d, cfg);
  assert.ok(!judge(d, cfg).skipped);
  fs.cpSync(pkg, path.join(d, 'Packages/com.me.old'), { recursive: true, preserveTimestamps: true });
  assert.match(judge(d, cfg).skipped || '', /Old has no project|assembly definitions/, 'a package copied in keeps its old times');
});

test('unity: a new script in an asmref folder belongs in its assembly\'s project', () => {
  const { d, cfg } = unityProject();
  write(d, 'Assets/Game/Game.asmdef', '{"name": "Game"}');
  write(d, 'Assets/Game/G.cs', '');
  write(d, 'Assets/Ext/Ext.asmref', '{"reference": "Game"}');
  tick();
  write(d, 'Game.csproj', '<AssemblyName>Game</AssemblyName><Compile Include="Assets\\Game\\G.cs" />');
  write(d, 'Game.sln', '"Game.csproj"');
  assert.ok(!judge(d, cfg).skipped);
  write(d, 'Assets/Ext/E.cs', 'broken {');
  assert.match(judge(d, cfg).skipped, /Assets\/Ext\/E\.cs is new/);
});

test('unity: a check that finds the projects current remembers the inputs, so a save that changed nothing stays current', () => {
  const { d, cfg } = unityProject();
  write(d, 'Assets/Scripts/Game.asmdef', '{"name": "Game"}');
  write(d, 'Assets/Scripts/Calc.cs', '');
  tick();
  write(d, 'Game.csproj', '<AssemblyName>Game</AssemblyName><Compile Include="Assets\\Scripts\\Calc.cs" />');
  write(d, 'Game.sln', '"Game.csproj"');
  assert.ok(!judge(d, cfg).skipped);
  tick();
  write(d, 'Assets/Scripts/Game.asmdef', '{"name": "Game"}');
  assert.strictEqual(judge(d, cfg, 'Calc.cs(1,2): error CS0103: bb does not exist').ok, false);
});

test('unity: a save that changed nothing after a braid Unity run keeps the projects current', () => {
  const { d, cfg } = unityProject();
  write(d, 'Assets/Scripts/Game.asmdef', '{"name": "Game"}');
  write(d, 'Assets/Scripts/Calc.cs', '');
  write(d, 'Assets/csc.rsp', '-nowarn:0169');
  write(d, 'Game.csproj', '<AssemblyName>Game</AssemblyName><Compile Include="Assets\\Scripts\\Calc.cs" />');
  write(d, 'Game.sln', '"Game.csproj"');
  // A braid Unity run during which Unity rewrites a project.
  const run = unityChecks(d, cfg, () => null).find(c => c.name === 'unity-compile');
  tick();
  run.prepare();
  write(d, 'Game.csproj', '<AssemblyName>Game</AssemblyName><Compile Include="Assets\\Scripts\\Calc.cs" />');
  tick();
  run.after({ ok: true, out: '', secs: 0, status: 0 });
  tick();
  write(d, 'Assets/Scripts/Game.asmdef', '{"name": "Game"}');
  assert.strictEqual(judge(d, cfg, 'Calc.cs(1,2): error CS0103: bb does not exist').ok, false, 'a typo still fails');
  write(d, 'Assets/csc.rsp', '-define:NET_DEBUG');
  assert.match(judge(d, cfg).skipped, /assembly definitions/, 'csc.rsp defines go into the projects too');
  write(d, 'Assets/csc.rsp', '-nowarn:0169');
  unityCompiled(d, cfg);
  write(d, 'Assets/Scripts/csc.rsp', '-define:ASM_DEBUG');
  assert.match(judge(d, cfg).skipped, /assembly definitions/, 'a csc.rsp next to an asmdef');
  fs.rmSync(path.join(d, 'Assets/Scripts/csc.rsp'));
  unityCompiled(d, cfg);
  fs.rmSync(path.join(d, 'Assets/csc.rsp'));
  assert.match(judge(d, cfg).skipped, /assembly definitions/, 'a deleted csc.rsp');
});

test('unity: a SKIP shows the errors it set aside, and a missing Library DLL is no error in the code', () => {
  const { d, cfg } = unityProject();
  write(d, 'Assets/A.cs', '');
  write(d, 'Assembly-CSharp.csproj', '<AssemblyName>Assembly-CSharp</AssemblyName><Compile Include="Assets\\A.cs" />');
  write(d, 'Game.sln', '"Assembly-CSharp.csproj"');
  assert.strictEqual(judge(d, cfg, 'A.cs(1,1): error CS0246: TMPro not found').ok, false);
  const dll = 'warning MSB3245: Could not resolve this reference "Unity.TextMeshPro"\nA.cs(1,1): error CS0246: TMPro not found';
  assert.match(judge(d, cfg, dll).skipped, /DLL[\s\S]*error CS0246: TMPro not found/);
  write(d, 'Assets/B.cs', '');
  assert.match(judge(d, cfg, 'A.cs(1,1): error CS0117: Debug has no Lgo').skipped, /Assets\/B\.cs is new[\s\S]*error CS0117/);
});

test('unity: a build that fails with no error in the code SKIPs', () => {
  const { d, cfg } = unityProject();
  write(d, 'Assets/A.cs', '');
  write(d, 'Assembly-CSharp.csproj', '<Compile Include="Assets\\A.cs" />');
  write(d, 'Game.sln', '"Assembly-CSharp.csproj"');
  assert.match(judge(d, cfg, 'error MSB4019: imported project not found').skipped, /no error in the code/);
  assert.match(judge(d, cfg, 'error CS0006: Metadata file Lib.dll could not be found').skipped, /no error in the code/);
  assert.match(judge(d, cfg, 'error NU1101: Unable to find package X').skipped, /no error in the code/);
  assert.strictEqual(judge(d, cfg, `${path.join(d, 'Assets', 'A.cs')}(3,5): error UNT0001: Empty Unity message`).ok, false, 'an analyzer error is in the code');
  const line = `${path.join(d, 'Assets', 'A.cs')}(1,73): error CS1002: ; expected [${path.join(d, 'Assembly-CSharp.csproj')}]`;
  assert.strictEqual(judge(d, cfg, `${line}\nBuild FAILED.\n${line}`).out, `1 compile error(s):\n${path.join('Assets', 'A.cs')}(1,73): error CS1002: ; expected`);
});

test('unity: the solution is the one named after the folder, else a whole one, chosen again before the build', () => {
  const { d, cfg } = unityProject();
  write(d, 'Assets/A.cs', '');
  write(d, 'Gone.csproj', '<Compile Include="Assets\\Deleted.cs" />');
  write(d, 'Assembly-CSharp.csproj', '<Compile Include="Assets\\A.cs" />');
  write(d, 'Old.sln', '"Assembly-CSharp.csproj" "Gone.csproj"');
  write(d, 'New.sln', '"Missing.csproj"');
  const scripts = () => unityChecks(d, cfg, () => 'dotnet').find(c => c.name === 'unity-scripts');
  const first = scripts();
  assert.ok(first.cmd.includes('Old.sln'), 'a newer solution that names a missing project is left over');
  write(d, `${path.basename(d)}.slnx`, '<Solution><Project Path="Assembly-CSharp.csproj" /></Solution>');
  assert.strictEqual(first.prepare(), null);
  assert.ok(first.cmd.includes(`${path.basename(d)}.slnx`), 'a Unity check earlier in the run wrote it');
  assert.ok(!first.after({ ok: true, out: '', secs: 0, status: 0 }).skipped, 'Unity leaves the csproj of a removed assembly behind, unlisted');
  assert.strictEqual(scripts().def, first.def, 'a new solution is not a new check command for the stop hook');
  const checks = unityChecks(d, cfg, () => 'dotnet');
  assert.strictEqual(checks[checks.length - 1].name, 'unity-scripts', 'after the Unity checks, which refresh the projects');
});

test('unity: test assemblies in embedded packages are run', () => {
  const { d, cfg } = unityProject();
  write(d, 'Packages/com.me.probe/Tests/Editor/Probe.Tests.asmdef', '{"name": "Probe.Tests", "includePlatforms": ["Editor"], "defineConstraints": ["UNITY_INCLUDE_TESTS"]}');
  assert.deepStrictEqual(unityChecks(d, cfg, () => null).map(c => c.name), ['unity-tests']);
});

test('unity: a failure shows the compile errors once each, or the failed tests from the results file', () => {
  const { d, cfg } = unityProject();
  write(d, 'Assets/Tests/T.asmdef', '{"name": "T", "includePlatforms": ["Editor"], "defineConstraints": ["UNITY_INCLUDE_TESTS"]}');
  const check = unityChecks(d, cfg, () => null).find(c => c.name === 'unity-tests');
  const failed = out => check.after({ ok: false, out, secs: 0, status: 1 }).out;
  const err = "Assets\\My Scripts\\Calc.cs(1,67): error CS0103: The name 'Foo' does not exist in the current context";
  assert.match(failed(`-r:"x.dll"\n${err}\n/nowarn:0169\n${err}\nScripts have compiler errors.`), /1 compile error\(s\):\nAssets\\My Scripts\\Calc\.cs\(1,67\): error CS0103/);
  const xml = check.cmd.match(/-testResults "([^"]+)"/)[1];
  assert.strictEqual(path.dirname(xml), path.join(ROOT, '.cache', 'braid'), 'per user, not in the shared temp folder');
  fs.mkdirSync(path.dirname(xml), { recursive: true });
  fs.writeFileSync(xml, '<test-run><test-case id="1" fullname="Ok.Skipped" result="Skipped" />' +
    '<test-case id="2" fullname="CalcTests.Adds(&quot;a&quot;)" result="Failed"><failure><message><![CDATA[  Expected: "&lt;b&gt;"\n  But was:  5\n]]></message>' +
    `<stack-trace><![CDATA[at NUnit.Framework.Assert.That () [0x00001]\nat Dict.get_Item (TKey key) [0x0001e] in <88e4733ac7bc4ae1b496735e6b83bbd3>:0\nat Lib.F () in /Users/bokken/build/Lib.cs:3\nat CalcTests.Adds () [0x00001] in ${path.join(d, 'Assets', 'Tests', 'CalcTests.cs')}:5\n]]></stack-trace></failure></test-case>` +
    '<test-case id="3" fullname="CalcTests.Passes" result="Passed"></test-case></test-run>');
  assert.strictEqual(failed('Test run completed. Exiting with code 2 (Failed).'),
    `1 test(s) failed:\nCalcTests.Adds("a")\n  Expected: "&lt;b&gt;"\n  But was:  5\n  at ${path.join('Assets', 'Tests', 'CalcTests.cs')}:5`);
  check.prepare();
  assert.ok(!fs.existsSync(xml), 'a results file from an earlier run is removed first');
});

test('findUnity: a standalone install in a "Unity <version>" folder counts', () => {
  const exe = path.join(tmp(), 'Unity 2022.3.10f1', 'Editor', WIN ? 'Unity.exe' : 'Unity');
  write(path.dirname(exe), path.basename(exe), '');
  assert.strictEqual(findUnity(exe, '2022.3.10f1'), exe);
});

test('run: skipOn turns a matching failure into SKIP, and runAfter skips a check whose dependency failed', async () => {
  const d = tmp();
  const live = { cmd: `${node} -e "console.log('Unable to build while Live Coding is active'); process.exit(6)"` };
  assert.strictEqual((await run(live, d)).ok, false);
  assert.strictEqual((await run({ ...live, skipOn: [[/Live Coding/, 'live']] }, d)).skipped, 'live');
  const after = { name: 't', needs: 'b', cmd: `${node} -e "process.exit(0)"` };
  assert.ok((await runAfter(after, d, { b: { ok: false } })).skipped);
  const r = await runAfter(after, d, { b: { ok: true } });
  assert.ok(r.ok && !r.skipped);
  const judged = await run({ cmd: `${node} -e "console.log('noise'); process.exit(1)"`, after: r => ({ ...r, out: 'the cause' }) }, d);
  assert.strictEqual(judged.out, 'the cause');
  assert.ok(!(await run({ ...live, cmd: `${node} -e "console.log('Live Coding')"`, skipOn: [[/Live Coding/, 'live']] }, d)).skipped, 'a passing run is never a SKIP');
});

test('snapshot: a Unity project\'s generated csproj files are not code, its package manifest is', () => {
  const d = tmp();
  write(d, 'ProjectSettings/ProjectVersion.txt', 'm_EditorVersion: 6000.0.1f1\n');
  write(d, 'Game.csproj', '');
  write(d, 'Assets/A.cs', '');
  write(d, 'Packages/manifest.json', '{}');
  write(d, 'Assets/csc.rsp', '');
  write(d, 'Tools/Build/Build.csproj', '');
  assert.deepStrictEqual(Object.keys(snapshot(d)), ['Assets/A.cs', 'Assets/csc.rsp', 'Packages/manifest.json', 'Tools/Build/Build.csproj']);
});

test('config: a braid.json saved with a BOM is still read', () => {
  const d = tmp();
  write(d, '.claude/braid.json', `﻿${JSON.stringify({ gate: 'off' })}`);
  assert.strictEqual(config(d).gate, 'off');
});
