'use strict';
// Unreal Engine and Unity checks. Each finds the exact engine version the project was made with and never
// another one (both engines open a project from a different version without asking, and may convert it).
// Things outside the code (an open editor, Live Coding, a license, a missing engine) make a check SKIP, not fail.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const WIN = process.platform === 'win32';
const MAC = process.platform === 'darwin';
const q = p => `"${p}"`;
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; } };
const read = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
const exists = f => { try { return fs.existsSync(f); } catch { return false; } };
const mtime = f => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };
// Per-user state, so other users of a shared machine cannot plant or read it. A relative path is ignored: XDG says
// so, and the hooks' working folder follows Claude's cd.
const cacheDir = () => path.resolve((path.isAbsolute(process.env.BRAID_CACHE_DIR || '') && process.env.BRAID_CACHE_DIR)
  || path.join(path.isAbsolute(process.env.XDG_CACHE_HOME || '') ? process.env.XDG_CACHE_HOME : path.join(os.homedir(), '.cache'), 'braid'));
const stateFile = (root, ext = 'json') => path.join(cacheDir(), `${crypto.createHash('sha1').update(path.resolve(root).toLowerCase()).digest('hex').slice(0, 16)}.${ext}`);
// Temp file and rename: a hook of another session never reads half a file.
function writeAtomic(f, text) {
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  const tmp = `${f}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, text);
    // Windows refuses a rename while another process holds the target for a moment: retry briefly.
    for (let i = 0; ; i++) {
      try { fs.renameSync(tmp, f); break; } catch (e) {
        if (!WIN || i >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) throw e;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (i + 1));
      }
    }
  } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
}
const programFiles = () => [process.env.ProgramFiles || 'C:/Program Files', process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)'];
const decode = t => t.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// Files under dir whose name matches re. Callers start inside Source, Content, a plugin's Source/Content,
// Assets or a package, never at a project root, so cache names (Library, Saved...) here are real folders.
// Hidden folders and Unity's ignored "name~" folders are skipped.
function filesUnder(dir, re, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!/^(\..*|.*~|node_modules)$/.test(e.name)) filesUnder(p, re, out); }
    else if (re.test(e.name)) out.push(p);
  }
  return out;
}

// Whether any file under dir matches re; stops at the first one.
function hasFile(dir, re) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
  return entries.some(e => (e.isDirectory() ? !/^(\..*|Binaries|Intermediate|Saved|DerivedDataCache)$/.test(e.name) && hasFile(path.join(dir, e.name), re) : re.test(e.name)));
}

// ---------- Unreal ----------

const unrealVersion = root => { const v = readJson(path.join(root, 'Engine', 'Build', 'Build.version')); return v ? `${v.MajorVersion}.${v.MinorVersion}` : null; };

// The engine for EngineAssociation: "5.8" (launcher install), a {GUID} (source build), or empty (the project sits in an engine source tree).
function findUnreal(configured, assoc, projectDir) {
  const candidates = [configured];
  const isVersion = /^\d+\.\d+$/.test(assoc);
  if (isVersion) {
    const dat = WIN ? path.join(process.env.ProgramData || 'C:/ProgramData', 'Epic', 'UnrealEngineLauncher', 'LauncherInstalled.dat')
      : path.join(os.homedir(), 'Library', 'Application Support', 'Epic', 'UnrealEngineLauncher', 'LauncherInstalled.dat');
    for (const i of (readJson(dat) || {}).InstallationList || []) if (i.AppName === `UE_${assoc}`) candidates.push(i.InstallLocation);
    if (WIN) {
      const r = spawnSync('reg', ['query', `HKLM\\SOFTWARE\\EpicGames\\Unreal Engine\\${assoc}`, '/v', 'InstalledDirectory'], { encoding: 'utf8' });
      const m = /InstalledDirectory\s+REG_SZ\s+(.+)/.exec(r.stdout || '');
      if (m) candidates.push(m[1].trim());
    }
    candidates.push(...(WIN ? programFiles().map(p => path.join(p, 'Epic Games', `UE_${assoc}`)) : [MAC ? `/Users/Shared/Epic Games/UE_${assoc}` : path.join(os.homedir(), `UnrealEngine-${assoc}`)]));
  } else if (/^\{?[0-9a-f]{8}-?([0-9a-f]{4}-?){3}[0-9a-f]{12}\}?$/i.test(assoc)) {
    const id = assoc.replace(/^\{?(.*?)\}?$/, '{$1}').toUpperCase();
    if (WIN) {
      const r = spawnSync('reg', ['query', 'HKCU\\Software\\Epic Games\\Unreal Engine\\Builds'], { encoding: 'utf8' });
      for (const line of (r.stdout || '').split(/\r?\n/)) {
        const m = /^\s*(\S+)\s+REG_SZ\s+(.+)$/.exec(line);
        if (m && m[1].toUpperCase() === id) candidates.push(m[2].trim());
      }
    } else {
      const ini = MAC ? path.join(os.homedir(), 'Library', 'Application Support', 'Epic', 'UnrealEngine', 'Install.ini') : path.join(os.homedir(), '.config', 'Epic', 'UnrealEngine', 'Install.ini');
      for (const line of read(ini).split(/\r?\n/)) { const m = /^\s*(\{?[^=]+?\}?)\s*=\s*(.+)$/.exec(line); if (m && m[1].replace(/^\{?(.*?)\}?$/, '{$1}').toUpperCase() === id) candidates.push(m[2].trim()); }
    }
  } else if (!assoc) {
    for (let d = path.dirname(path.resolve(projectDir)); d !== path.dirname(d); d = path.dirname(d)) candidates.push(d);
  }
  // A machine-wide default comes last: the project's own association names a more specific engine.
  candidates.push(process.env.UE_ROOT);
  // A version association must match the engine's own Build.version exactly.
  return candidates.find(c => c && unrealVersion(c) && (!isVersion || unrealVersion(c) === assoc)) || null;
}

// The Editor target: Source/<Name>.Target.cs with Type = TargetType.Editor.
function editorTarget(root) {
  let files = [];
  try { files = fs.readdirSync(path.join(root, 'Source')).filter(f => f.endsWith('.Target.cs')); } catch { return null; }
  const f = files.find(x => /Type\s*=\s*TargetType\.Editor/.test(read(path.join(root, 'Source', x))));
  return f ? f.slice(0, -'.Target.cs'.length) : null;
}

// The project's plugins. Unreal finds them at any depth under Plugins/ (e.g. Plugins/GameFeatures/<Name>);
// a folder holding a .uplugin is one plugin, mounted at /<.uplugin name>, and is not searched further.
function plugins(root) {
  const out = [];
  const walk = dir => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const up = entries.find(e => e.isFile() && e.name.endsWith('.uplugin'));
    if (up) { out.push({ dir, name: up.name.slice(0, -'.uplugin'.length), file: path.join(dir, up.name) }); return; }
    for (const e of entries) if (e.isDirectory() && !e.name.startsWith('.')) walk(path.join(dir, e.name));
  };
  walk(path.join(root, 'Plugins'));
  return out;
}

// First segments of automation test names in the project's own code (not marketplace plugins).
function testPrefixes(root) {
  const dirs = [path.join(root, 'Source')];
  for (const p of plugins(root)) if (!/"(MarketplaceURL|FabURL)"\s*:\s*"[^"\s]/.test(read(p.file))) dirs.push(path.join(p.dir, 'Source'));
  const found = new Set();
  // \b keeps END_DEFINE_SPEC out; [^")] stops at the macro's own arguments; the name goes into -ExecCmds, so word characters only.
  const re = /(?:\bIMPLEMENT_\w*AUTOMATION_TEST\w*|\bBEGIN_DEFINE_SPEC|\bDEFINE_SPEC)\s*\([^")]*"([\w ]+)(?=[."])/g;
  for (const d of dirs) for (const f of filesUnder(d, /\.(cpp|h)$/)) for (const m of read(f).matchAll(re)) found.add(m[1]);
  return [...found];
}

// Every .uasset as an object path (/Game/Dir/Name.Name), for CompileAllBlueprints' allow list.
function assetPaths(root) {
  const out = [];
  const mounts = [[path.join(root, 'Content'), '/Game'], ...plugins(root).map(p => [path.join(p.dir, 'Content'), `/${p.name}`])];
  for (const [dir, mount] of mounts) {
    for (const f of filesUnder(dir, /\.uasset$/)) {
      const rel = path.relative(dir, f).replace(/\\/g, '/').replace(/\.uasset$/, '');
      out.push(`${mount}/${rel}.${path.basename(rel)}`);
    }
  }
  return out;
}

function unrealChecks(root, cfg, uproject) {
  const up = readJson(path.join(root, uproject)) || {};
  const assoc = String(up.EngineAssociation || '');
  const engine = findUnreal(cfg.unrealEngine, assoc, root);
  if (!engine) {
    return [{ name: 'unreal', skip: `Unreal Engine ${assoc || '(no EngineAssociation)'} not found: set UE_ROOT or "unrealEngine" in .claude/braid.json. braid never opens a project with another engine version.` }];
  }
  // UE4 ships other binaries (UE4Editor-Cmd) and commandlet flags.
  if (Number(unrealVersion(engine).split('.')[0]) < 5) return [{ name: 'unreal', skip: `Unreal Engine 5 is needed: this project uses ${unrealVersion(engine)}. Put its checks in .claude/braid.json.` }];
  // UnrealBuildTool refuses any intermediate path of 260+ characters, whatever the Windows long-path setting.
  const len = path.resolve(root).length;
  if (WIN && len + 135 >= 260) return [{ name: 'unreal', skip: `the project path is ${len} characters, too long for UnrealBuildTool (about 124 at most): move the project to a shorter path` }];

  const upAbs = path.resolve(root, uproject);
  const bin = path.join(engine, 'Engine', 'Binaries');
  const editor = WIN ? path.join(bin, 'Win64', 'UnrealEditor-Cmd.exe')
    : MAC ? (exists(path.join(bin, 'Mac', 'UnrealEditor-Cmd')) ? path.join(bin, 'Mac', 'UnrealEditor-Cmd') : path.join(bin, 'Mac', 'UnrealEditor.app', 'Contents', 'MacOS', 'UnrealEditor'))
    : path.join(bin, 'Linux', 'UnrealEditor');
  const headless = '-unattended -nopause -nullrhi -nosplash -NoSound -stdout -FullStdOutLogOutput';
  const checks = [];

  const target = editorTarget(root);
  if (target) {
    const build = WIN ? path.join(engine, 'Engine', 'Build', 'BatchFiles', 'Build.bat') : path.join(engine, 'Engine', 'Build', 'BatchFiles', MAC ? 'Mac' : 'Linux', 'Build.sh');
    checks.push({
      name: 'unreal-build',
      cmd: `${q(build)} ${target} ${WIN ? 'Win64' : MAC ? 'Mac' : 'Linux'} Development -Project=${q(upAbs)} -WaitMutex -NoHotReload`,
      skipOn: [
        [/Unable to build while Live Coding is active/, 'Live Coding is active in an open Unreal Editor: compile there with Ctrl+Alt+F11, or close the editor'],
        [/LNK1104[^\n]*UnrealEditor-[^\n]*\.dll/i, 'an open Unreal Editor holds the project DLL: compile there with Live Coding, or close the editor'],
      ],
    });
    const prefixes = testPrefixes(root);
    if (prefixes.length) {
      checks.push({
        name: 'unreal-tests',
        needs: 'unreal-build', // the editor loads the built DLL and never rebuilds it
        cmd: `${q(editor)} ${q(upAbs)} -ExecCmds="Automation RunTests ${prefixes.map(p => `StartsWith:${p}`).join('+')};Quit" ${headless}`,
        failOn: /Result=\{Fail\}|TEST COMPLETE\. EXIT CODE: -1|No automation tests matched/,
      });
    }
  }

  // Without a filter the commandlet compiles the engine's own Blueprints too; the allow list keeps it to the project.
  if (hasFile(path.join(root, 'Content'), /\.uasset$/) || hasFile(path.join(root, 'Plugins'), /\.uasset$/)) {
    const allow = path.join(root, 'Saved', 'BraidBPAllow.txt');
    checks.push({
      name: 'unreal-blueprints',
      needs: target ? 'unreal-build' : undefined,
      prepare: () => {
        const list = assetPaths(root);
        if (!list.length) return 'no Blueprint assets';
        fs.mkdirSync(path.dirname(allow), { recursive: true });
        fs.writeFileSync(allow, `${list.join('\n')}\n`);
        return null;
      },
      cmd: `${q(editor)} ${q(upAbs)} -run=CompileAllBlueprints -AllowListFile=Saved/BraidBPAllow.txt ${headless}`,
    });
  }
  return checks;
}

// ---------- Unity ----------

// The Hub installs editors as <hub>/<version>/...; a custom location is stored in secondaryInstallPath.json.
function findUnity(configured, version) {
  // A configured editor counts only if it is this version's install: its path has the version as a folder.
  for (const p of [configured, process.env.UNITY_BIN]) if (p && exists(p) && (!version || p.split(/[\\/ ]/).includes(version))) return p;
  if (!version) return null;
  const hubConfig = WIN ? path.join(process.env.APPDATA || '', 'UnityHub') : MAC ? path.join(os.homedir(), 'Library', 'Application Support', 'UnityHub') : path.join(os.homedir(), '.config', 'UnityHub');
  const secondary = readJson(path.join(hubConfig, 'secondaryInstallPath.json'));
  const hubs = [typeof secondary === 'string' && secondary, ...(WIN ? programFiles().map(p => path.join(p, 'Unity', 'Hub', 'Editor')) : [MAC ? '/Applications/Unity/Hub/Editor' : path.join(os.homedir(), 'Unity', 'Hub', 'Editor')])].filter(Boolean);
  const rel = WIN ? ['Editor', 'Unity.exe'] : MAC ? ['Unity.app', 'Contents', 'MacOS', 'Unity'] : ['Editor', 'Unity'];
  return hubs.map(h => path.join(h, version, ...rel)).find(exists) || null;
}

// Unity holds Temp/UnityLockfile exclusively while the project is open; a leftover file is not a lock.
function unityOpen(root) {
  if (!WIN) return false; // elsewhere open() does not fail: Unity's own message is caught by skipOn
  try { fs.closeSync(fs.openSync(path.join(root, 'Temp', 'UnityLockfile'), 'r+')); return false; } catch (e) { return e.code === 'EBUSY' || e.code === 'EPERM'; }
}

// Assets plus the embedded packages (folders under Packages/; registry packages live in Library).
function unityDirs(root) {
  let pkgs = [];
  try { pkgs = fs.readdirSync(path.join(root, 'Packages'), { withFileTypes: true }).filter(e => e.isDirectory()).map(e => path.join('Packages', e.name)); } catch { /* none */ }
  return ['Assets', ...pkgs].map(d => path.join(root, d));
}

// Test assemblies: asmdefs that compile only with UNITY_INCLUDE_TESTS or reference NUnit; Editor-only ones are EditMode.
function unityTests(root) {
  const kinds = { edit: false, play: false };
  for (const f of unityDirs(root).flatMap(d => filesUnder(d, /\.asmdef$/))) {
    const a = readJson(f) || {};
    const isTest = (a.defineConstraints || []).includes('UNITY_INCLUDE_TESTS') || (a.precompiledReferences || []).includes('nunit.framework.dll');
    if (!isTest) continue;
    const plats = a.includePlatforms || [];
    if (plats.length === 1 && plats[0] === 'Editor') kinds.edit = true;
    else kinds.play = true;
  }
  return kinds;
}

const slnProjects = (root, sln) => [...read(path.join(root, sln)).matchAll(/"([^"]+\.csproj)"/g)].map(m => path.join(root, m[1]));

// Unity names the solution after the project folder and never deletes an older one. A solution that names a
// missing project is left over from an older layout. Then the newest wins.
function unitySln(root) {
  let slns = [];
  try { slns = fs.readdirSync(root).filter(f => /\.slnx?$/.test(f)); } catch { return null; }
  const whole = slns.filter(f => slnProjects(root, f).every(exists));
  const pool = whole.length ? whole : slns;
  const base = path.basename(path.resolve(root));
  const named = pool.filter(f => f.replace(/\.slnx?$/, '') === base);
  return (named.length ? named : pool).sort((a, b) => mtime(path.join(root, b)) - mtime(path.join(root, a)))[0] || null;
}

// What Unity's generated projects depend on besides the scripts: the assembly definitions, the compiler options
// files (Assets/csc.rsp, or one next to an asmdef) and the package manifest. Unity skips hidden files.
const INPUT = /^[^.].*\.(asmdef|asmref)$|^csc\.rsp$/;
const unityInputs = (root, found = unityDirs(root).flatMap(d => filesUnder(d, INPUT))) => [path.join(root, 'Packages', 'manifest.json'), ...found.filter(f => INPUT.test(path.basename(f)))];
const relTo = (root, f) => path.relative(root, f).replace(/\\/g, '/');
const hash = f => crypto.createHash('sha1').update(read(f)).digest('hex');
// A copy or a move keeps a file's mtime but sets its ctime.
const touched = f => { try { const s = fs.statSync(f); return Math.max(s.mtimeMs, s.ctimeMs); } catch { return 0; } };
// The editor builds an assembly for itself unless its platforms leave the Editor out or a define it needs is unset.
// shortcut: only UNITY_INCLUDE_TESTS counts as set; an assembly that needs another symbol is never expected to have a project, and a new one is still caught as a changed input.
const editorBuilds = j => (j.defineConstraints || []).every(c => c === 'UNITY_INCLUDE_TESTS') && !(j.excludePlatforms || []).includes('Editor')
  && (!(j.includePlatforms || []).length || j.includePlatforms.includes('Editor'));

// Whether Unity's generated C# projects may lag behind the code, so a dotnet build of them cannot vouch for it.
// stale: their contents show it (a script new, gone or in another assembly, an assembly without its project).
// behind: an input changed after the last time Unity is known to have regenerated them. That is the newest project,
// or `rec`, the last braid Unity run that compiled (Unity rewrites a project only when its text changes, so after
// a change that alters no project only that run proves it saw the change). rec.hashes, the inputs' contents at
// that run, tell a save that changed nothing from a real change.
function unityProject(root, sln, rec) {
  const rel = f => relTo(root, f);
  const projects = slnProjects(root, sln).map(f => {
    const text = read(f);
    const files = [...text.matchAll(/<Compile Include="([^"]+)"/g)].map(m => decode(m[1]).replace(/\\/g, '/'));
    return { name: (text.match(/<AssemblyName>([^<]+)<\/AssemblyName>/) || [])[1] || path.basename(f, '.csproj'), files, time: mtime(f) };
  });
  const listed = new Set(projects.flatMap(p => p.files));
  const found = unityDirs(root).flatMap(d => filesUnder(d, /^[^.].*\.(cs|asmdef|asmref)$|^csc\.rsp$/));
  // Unity skips hidden files (macOS "._" copies) and never compiles StreamingAssets.
  const scripts = found.filter(f => f.endsWith('.cs')).map(rel).filter(f => !f.startsWith('Assets/StreamingAssets/'));
  // Embedded packages get projects only when the IDE integration is set to generate them.
  const withPkgs = [...listed].some(f => f.startsWith('Packages/'));
  // A script belongs to the nearest asmdef/asmref folder above it, or to Assembly-CSharp (Assets only).
  const defs = found.filter(f => /\.asm(def|ref)$/.test(f)).map(f => {
    const j = readJson(f) || {};
    return { dir: `${rel(path.dirname(f))}/`, name: f.endsWith('.asmref') ? j.reference : j.name, json: f.endsWith('.asmdef') && j };
  }).sort((a, b) => b.dir.length - a.dir.length);
  const owner = f => defs.find(d => f.startsWith(d.dir));
  const listedOwners = new Set([...listed].map(owner));
  const names = new Set(projects.map(p => p.name));
  const stale = [
    ...scripts.filter(f => !listed.has(f) && (owner(f) ? listedOwners.has(owner(f)) || names.has(owner(f).name) : f.startsWith('Assets/'))).map(f => `${f} is new`),
    ...[...listed].filter(f => !path.isAbsolute(f) && !exists(path.join(root, f))).map(f => `${f} is gone`),
    // An asmdef deleted, moved or renamed since: a listed script now belongs to another assembly.
    ...projects.map(p => p.files.find(f => {
      if (!/^(Assets|Packages)\//.test(f) || !exists(path.join(root, f))) return false;
      const o = owner(f);
      return /^Assembly-CSharp/.test(p.name) ? Boolean(o) : !o || (!/^GUID:/i.test(o.name || '') && o.name !== p.name);
    })).filter(Boolean).map(f => `${f} is in another assembly now`),
    // An asmdef copied in with its old file times.
    ...defs.filter(d => d.json && !names.has(d.name) && (withPkgs || d.dir.startsWith('Assets/')) && editorBuilds(d.json) && scripts.some(f => owner(f) === d)).map(d => `${d.name} has no project`),
  ];
  const newest = Math.max(0, ...projects.map(p => p.time));
  // A record newer than every project says what the inputs were when the projects matched them: compare contents,
  // whatever the file times (they can be coarser than the clock). Otherwise a project Unity wrote later is the last
  // sign, and anything touched after it counts.
  const inputs = unityInputs(root, found);
  const recorded = rec.hashes && (rec.t || 0) >= newest;
  const changedInput = recorded
    ? Object.keys(rec.hashes).some(k => !exists(path.join(root, k))) || inputs.some(f => exists(f) && rec.hashes[rel(f)] !== hash(f))
    : inputs.some(f => touched(f) > newest);
  // Without package projects, Assets code compiles against the package DLLs of Unity's last successful build, so any
  // change to a package since counts: a file edited or moved in, or one removed, which changes its folder's times.
  // shortcut: a package folder moved in by a rename keeps its old times and is missed until Unity rebuilds its DLL.
  const pkgRoot = path.join(root, 'Packages');
  const dirsUnder = (d, out = []) => {
    out.push(d);
    try { for (const e of fs.readdirSync(d, { withFileTypes: true })) if (e.isDirectory() && !/^(\..*|.*~)$/.test(e.name)) dirsUnder(path.join(d, e.name), out); } catch { /* gone */ }
    return out;
  };
  const pkgPaths = withPkgs ? [] : [...dirsUnder(pkgRoot), ...found.filter(f => f.startsWith(pkgRoot + path.sep))];
  const dlls = path.join(root, 'Library', 'ScriptAssemblies');
  const built = Math.max(rec.t || 0, ...(() => { try { return fs.readdirSync(dlls).map(f => mtime(path.join(dlls, f))); } catch { return []; } })());
  const behind = changedInput || pkgPaths.some(f => touched(f) > built);
  return { stale: stale.slice(0, 3).join(', ') + (stale.length > 3 ? ` and ${stale.length - 3} more` : ''), behind };
}

// A compiler log boiled down to its errors, each once, paths relative to the project. The report shows the
// last 40 lines of a failure, so the first 30 errors (usually the cause of the rest) are kept.
function compileErrors(out, root) {
  const abs = `${path.resolve(root)}${path.sep}`.toLowerCase();
  const errors = [...new Set(out.split(/\r?\n/).filter(l => /\(\d+,\d+\): error [A-Z]{2,}\d{3,}:/.test(l)).map(l => {
    const e = l.trim().replace(/\s*\[[^\]]+\.csproj\]$/, '');
    return e.toLowerCase().startsWith(abs) ? e.slice(abs.length) : e;
  }))];
  if (!errors.length) return null;
  return `${errors.length} compile error(s):\n${errors.slice(0, 30).join('\n')}${errors.length > 30 ? `\n... and ${errors.length - 30} more` : ''}`;
}

// Unity's log is mostly compiler arguments and shutdown noise, and never names a failed test: show the compile
// errors, or the failed tests from the results file.
function unityExplain(out, xml, root) {
  const errors = compileErrors(out, root);
  if (errors) return `Unity compiles the whole project before it runs anything. ${errors}`;
  if (!xml) return null;
  // Self-closing test-cases (never failed ones) are left out, so a match cannot swallow the next case.
  const failed = [...read(xml).matchAll(/<test-case\b([^>]*[^/])>([\s\S]*?)<\/test-case>/g)].filter(m => /\bresult="Failed"/.test(m[1])).map(m => {
    const cdata = tag => ((m[2].match(new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`)) || [])[1] || '').trim();
    // The first frame in the project's own files: Mono frames end in " in <file>:<line>", Unity's in "(at <file>:<line>)".
    const at = cdata('stack-trace').split(/\r?\n/).map(l => l.match(/(?: in |\(at )(.+):(\d+)\)?\s*$/))
      .map(a => a && [path.isAbsolute(a[1]) ? path.relative(root, a[1]) : a[1], a[2]]).find(a => a && /^(Assets|Packages)[\\/]/.test(a[0]));
    const msg = cdata('message').split(/\r?\n/).slice(0, 3).map(l => `  ${l.trim()}`).join('\n');
    return `${decode((m[1].match(/\bfullname="([^"]*)"/) || [])[1] || '?')}\n${msg}${at ? `\n  at ${at[0]}:${at[1]}` : ''}`;
  });
  if (!failed.length) return null;
  const more = failed.length > 6 ? `\n... and ${failed.length - 6} more in ${xml}` : '';
  return `${failed.length} test(s) failed:\n${failed.slice(0, 6).join('\n')}${more}`;
}

// Errors that projects generated before the latest asmdef, package or script change would also give: a missing
// type, namespace, name, member or file. Any other compiler error is in the code whatever the projects say.
const STALE_REFS = new Set(['CS0246', 'CS0234', 'CS0103', 'CS0012', 'CS0006', 'CS1061', 'CS0117', 'CS2001', 'MSB3202']);
const errorCodes = out => [...out.matchAll(/error ([A-Z]{2,}\d{3,})/g)].map(m => m[1]);
// MSBuild, SDK and NuGet errors, and a missing referenced assembly, are about the build, not the code.
const notInCode = c => /^(MSB|NETSDK|NU)/.test(c) || c === 'CS0006';
// The inputs as they are now, and the record of a moment Unity's projects were known to match them.
const inputHashes = root => Object.fromEntries(unityInputs(root).filter(exists).map(f => [relTo(root, f), hash(f)]));
function writeRecord(file, hashes) {
  try { writeAtomic(file, JSON.stringify({ t: Date.now(), hashes })); } catch { /* next time */ }
}

function unityChecks(root, cfg, onPath) {
  const version = (read(path.join(root, 'ProjectSettings', 'ProjectVersion.txt')).match(/^m_EditorVersion:\s*(\S+)/m) || [])[1] || '';
  const checks = [];
  // The last braid Unity run that compiled the project (Unity regenerates its C# projects then), per user like braid's state.
  const syncFile = stateFile(root, 'unity-synced.json');
  const open = 'the project is open in the Unity Editor: close it, or run the tests from its Test Runner';
  const unity = findUnity(cfg.unity, version);
  if (unity) {
    const skip = unityOpen(root) ? open : undefined;
    const skipOn = [
      [/No valid Unity Editor license found|return code 198/, 'no valid Unity license: open Unity Hub and sign in to refresh it'],
      [/another Unity instance is running with this project open/, open],
    ];
    const base = `${q(unity)} -batchmode -nographics -projectPath ${q(path.resolve(root))} -logFile -`;
    const tests = unityTests(root);
    // The inputs are hashed before the run, as Unity is about to see them.
    let seen = null;
    const batch = (check, xml) => Object.assign(check, {
      skip, skipOn,
      prepare: () => {
        if (xml) {
          fs.mkdirSync(path.dirname(xml), { recursive: true, mode: 0o700 });
          fs.rmSync(xml, { force: true }); // a results file left by an earlier run would explain the wrong failure
        }
        seen = inputHashes(root);
      },
      // Test runs exit 1 on compile errors, 2 on failed tests, so 0 and 2 mean the code compiled.
      after: r => {
        // Recorded at the run's end: projects Unity wrote during it came from the inputs hashed before it.
        if (!r.skipped && (r.ok || r.status === 2)) writeRecord(syncFile, seen);
        return r.ok ? r : { ...r, out: unityExplain(r.out, xml, root) || r.out };
      },
    });
    const testRun = (name, platform, xml) => batch({ name, cmd: `${base} -runTests -testPlatform ${platform} -testResults ${q(xml)}` }, xml);
    // Results in the per-user state folder: a predictable name in the shared temp folder could be planted.
    if (tests.edit) checks.push(testRun('unity-tests', 'EditMode', stateFile(root, 'unity-edit.xml')));
    if (tests.play) checks.push(testRun('unity-playmode', 'PlayMode', stateFile(root, 'unity-play.xml')));
    if (!tests.edit && !tests.play) checks.push(batch({ name: 'unity-compile', cmd: `${base} -quit`, failOn: /error CS\d{4}|Scripts have compiler errors/ }, null));
  } else {
    const ignored = [cfg.unity, process.env.UNITY_BIN].filter(p => p && exists(p));
    checks.push({ name: 'unity', skip: `Unity ${version || '(unknown version)'} not installed${ignored.length ? ` (${ignored.join(', ')} is another version, so it is not used)` : ''}: install exactly this version with Unity Hub, or set UNITY_BIN or "unity" in .claude/braid.json to an editor whose path has a folder named after the version (".../${version || '<version>'}/Editor/..."). braid never opens a project with another Unity version.` });
  }
  // The solution the IDE integration generated, built by dotnet in seconds: the stop hook's compile check, and the
  // only one while the editor has the project open. Last, so a Unity run before it has refreshed the projects.
  const sln = unitySln(root);
  if (sln && onPath('dotnet')) {
    const build = s => `dotnet build ${q(path.join(root, s))} --nologo -v q`;
    const refresh = 'Unity regenerates them when the editor gets focus, or in a braid run once the code compiles (with the editor closed)';
    let project = { stale: '', behind: false };
    const check = {
      // Unity writing a new solution during a turn is not a change of the check command.
      name: 'unity-scripts', cmd: build(sln), def: 'dotnet build <Unity\'s solution>',
      prepare: () => {
        // Chosen again: a Unity check earlier in this run may have just written the solution.
        const now = unitySln(root);
        if (!now) return `Unity's generated solution is gone: ${refresh}`;
        check.cmd = build(now);
        project = unityProject(root, now, readJson(syncFile) || {});
        // Current projects: remember the inputs, so a later save that changes nothing does not look like a change.
        if (!project.stale && !project.behind) writeRecord(syncFile, inputHashes(root));
        return null;
      },
      after: r => {
        if (r.timedOut) return r;
        // A SKIP keeps the errors it sets aside in view: they may be real.
        const skipped = reason => {
          const text = [reason, compileErrors(r.out, root)].filter(Boolean).join('\n');
          return { ok: true, skipped: text, out: text, secs: r.secs };
        };
        const why = project.stale ? `Unity's generated C# projects are out of date (${project.stale}), so this build cannot vouch for the code: ${refresh}`
          : project.behind ? `assembly definitions, packages or compiler options changed since Unity last regenerated its C# projects, so this build cannot vouch for the code: ${refresh}` : null;
        if (r.ok) return why ? skipped(why) : r;
        const codes = errorCodes(r.out);
        if (codes.every(notInCode)) {
          const line = (r.out.split(/\r?\n/).find(l => /error/i.test(l)) || '').trim().slice(0, 300);
          return skipped(`dotnet could not build Unity's generated C# projects, and no error in the code says why${line ? ` (${line})` : ''}: the Unity checks compile the code instead`);
        }
        if (codes.every(c => STALE_REFS.has(c))) {
          if (why) return skipped(why);
          // Library was deleted or not built yet: package DLLs the projects reference are missing.
          const dll = (r.out.match(/warning MSB3245:[^\r\n]*/) || [])[0];
          if (dll) return skipped(`a DLL that Unity's generated C# projects reference is missing (Unity rebuilds Library when it opens the project), so these errors may not be in the code: ${dll.slice(0, 200)}`);
        }
        return { ...r, out: compileErrors(r.out, root) || r.out };
      },
    };
    checks.push(check);
  }
  return checks;
}

module.exports = { unrealChecks, unityChecks, findUnreal, findUnity, testPrefixes, assetPaths, readJson, stateFile, writeAtomic, programFiles };
