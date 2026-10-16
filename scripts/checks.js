#!/usr/bin/env node
// Finds and runs a project's real checks: types, lint, tests, build.
// Usage: node checks.js [dir] [--list] [--fast] [--reviewed]   Exit: 0 all green, 1 something failed, 3 no checks found.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const WIN = process.platform === 'win32';
const TIMEOUT_MS = Number(process.env.BRAID_TIMEOUT || 600) * 1000;
const TAIL_LINES = 40;
// Checks cheap enough for the stop gate; tests and builds run in the /braid loop.
const FAST = /^(types|typecheck|type-check|lint|vet|gdlint|godot-import|godot-scripts)$/;
// Godot exits 0 on most script errors, so failures are read from its output.
// Engine noise printed at shutdown is not a failure of the code.
const GODOT_FAIL = /SCRIPT ERROR|Parse Error|Compile Error|Failed to load script|^ERROR:(?!.*(Unreferenced static string|RID allocations|leaked at exit|still in use at exit|PagedAllocator))/m;
const CODE = /\.(gd|gdshader|gdshaderinc|tscn|tres|cs|fs|csproj|fsproj|js|jsx|mjs|cjs|ts|tsx|mts|cts|vue|svelte|py|pyi|rs|go|java|kt|kts|scala|c|cc|cpp|h|hpp|m|mm|rb|php|swift|dart|ex|exs|zig|hs|ml|lua|sql)$|(^|\/)(project\.godot|package\.json|tsconfig[^/]*\.json|deno\.jsonc?|pyproject\.toml|Cargo\.toml|go\.mod|pom\.xml|build\.gradle|Package\.swift|pubspec\.yaml|mix\.exs|Gemfile|composer\.json|Makefile|CMakeLists\.txt)$/;

const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const config = root => readJson(path.join(root, '.claude', 'braid.json')) || {};

function detect(root) {
  const has = f => fs.existsSync(path.join(root, f));
  const read = f => { try { return fs.readFileSync(path.join(root, f), 'utf8'); } catch { return ''; } };
  const q = p => `"${p}"`;
  const cfg = config(root);
  if (cfg.checks) return Object.entries(cfg.checks).map(([name, cmd]) => ({ name, cmd }));

  const entries = (() => { try { return fs.readdirSync(root); } catch { return []; } })();
  const checks = [];
  const add = (name, cmd, failOn) => checks.push({ name, cmd, failOn });

  if (has('package.json')) {
    const scripts = (readJson(path.join(root, 'package.json')) || {}).scripts || {};
    const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lockb') || has('bun.lock') ? 'bun' : 'npm';
    // A solution-style tsconfig (only "references") checks nothing without -b.
    if (!scripts.typecheck && !scripts['type-check'] && has('tsconfig.json') && has('node_modules/typescript')) {
      add('types', /"references"\s*:/.test(read('tsconfig.json')) ? 'npx tsc -b' : 'npx tsc --noEmit');
    }
    for (const s of ['typecheck', 'type-check', 'lint', 'test', 'build']) {
      if (scripts[s] && !/no test specified/.test(scripts[s])) add(s, `${pm} run ${s}`);
    }
  }

  if (has('deno.json') || has('deno.jsonc')) { add('lint', 'deno lint'); add('types', 'deno check .'); add('test', 'deno test -A'); }

  if (has('pyproject.toml') || has('setup.py') || has('setup.cfg') || has('requirements.txt')) {
    const py = read('pyproject.toml') + read('setup.cfg');
    // Locked environments run their own tools; plain ones use what is on PATH.
    const env = has('uv.lock') ? 'uv run ' : has('poetry.lock') ? 'poetry run ' : '';
    if (onPath('ruff') || (env && py.includes('ruff'))) add('lint', `${env}ruff check .`);
    if ((py.includes('mypy') || has('mypy.ini')) && (env || onPath('mypy'))) add('types', `${env}mypy .`);
    if (has('tests') || has('test') || py.includes('pytest')) add('test', env ? `${env}pytest -q` : `${WIN ? 'python' : 'python3'} -m pytest -q`);
  }

  if (has('Cargo.toml')) { if (onPath('cargo-clippy')) add('clippy', 'cargo clippy --all-targets --quiet'); add('test', 'cargo test --quiet'); }
  if (has('go.mod')) { add('vet', 'go vet ./...'); add('test', 'go test ./...'); }
  if (entries.some(f => /\.(sln|csproj)$/.test(f))) add('dotnet', 'dotnet test --nologo');
  if (has('gradlew') || has('gradlew.bat')) add('test', WIN ? 'gradlew.bat test --quiet' : './gradlew test --quiet');
  else if (has('pom.xml')) add('test', 'mvn -q test');
  if (has('Package.swift')) add('test', 'swift test');
  if (has('pubspec.yaml')) { const flutter = read('pubspec.yaml').includes('flutter:'); add('lint', `${flutter ? 'flutter' : 'dart'} analyze`); if (has('test')) add('test', `${flutter ? 'flutter' : 'dart'} test`); }
  if (has('mix.exs')) add('test', 'mix test');
  if (has('Gemfile')) { if (has('spec')) add('test', 'bundle exec rspec'); else if (/^\s*task|Rake::TestTask/m.test(read('Rakefile'))) add('test', 'bundle exec rake test'); }
  if (has('composer.json')) {
    const scripts = (readJson(path.join(root, 'composer.json')) || {}).scripts || {};
    if (scripts.test) add('test', 'composer test');
    else if (has('vendor/bin/phpunit')) add('test', WIN ? 'vendor\\bin\\phpunit' : 'vendor/bin/phpunit');
  }

  if (has('project.godot')) {
    const pg = read('project.godot');
    // Godot 4 writes config_version=5. Godot 3 projects need Godot 3 tools: put their checks in braid.json.
    if (Number((pg.match(/^config_version=(\d+)/m) || [])[1]) >= 5) {
      const version = (pg.match(/config\/features=PackedStringArray\("(\d+\.\d+)"/) || [])[1];
      const mono = pg.includes('"C#"') || entries.some(f => /\.csproj$/.test(f));
      const godot = findGodot(cfg.godot, { version, mono });
      if (!godot) {
        checks.push({ name: 'godot-import', missing: `Godot ${mono ? '.NET ' : ''}binary not found: set GODOT_BIN or "godot" in .claude/braid.json` });
      } else {
        const run = `${q(godot)} --headless --no-header --path ${q(root)}`;
        // Import refreshes the class_name cache the other checks compile against.
        add('godot-import', `${run} --import`, GODOT_FAIL);
        // --import only compiles what something references; this loads every script and scene.
        add('godot-scripts', `${run} --script ${q(path.join(__dirname, 'godot_check.gd').replace(/\\/g, '/'))}`, GODOT_FAIL);
        const testDir = has('test') ? 'res://test' : 'res://tests';
        if (has('addons/gut')) add('gut', `${run} -s res://addons/gut/gut_cmdln.gd ${has('.gutconfig.json') ? '' : `-gdir=${testDir} -ginclude_subdirs `}-gexit`, GODOT_FAIL);
        if (has('addons/gdUnit4')) checks.push({ name: 'gdunit4', cmd: `${run} -s res://addons/gdUnit4/bin/GdUnitCmdTool.gd -a ${testDir} -c --ignoreHeadlessMode`, failOn: GODOT_FAIL, okCodes: [0, 101] });
        for (const t of godotTests(root)) add(`godot-test ${t}`, `${run} --script res://${t}`, GODOT_FAIL);
      }
    }
    if (onPath('gdlint')) add('gdlint', 'gdlint .');
  }

  if (!checks.length && /^test:/m.test(read('Makefile'))) add('test', 'make test');
  return checks;
}

// Scripts under test/ or tests/ that run on their own (extends SceneTree) and quit with a code.
function godotTests(root) {
  const out = [];
  const walk = rel => {
    let entries = [];
    try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(r);
      else if (e.name.endsWith('.gd') && /^extends\s+(SceneTree|MainLoop)\b/m.test(fs.readFileSync(path.join(root, r), 'utf8'))) out.push(r);
    }
  };
  walk('test');
  walk('tests');
  return out;
}

// Configured path first, then PATH, then portable downloads. Among downloads, the build matching
// the project's version and flavor (.NET or not) wins, else the newest.
// On Windows the _console.exe twin is used: it reliably reports exit codes and output.
function findGodot(configured, want = {}) {
  const consoleTwin = p => {
    const c = p.replace(/(_console)?\.exe$/i, '_console.exe');
    return WIN && fs.existsSync(c) ? c : p;
  };
  for (const p of [configured, process.env.GODOT_BIN, process.env.GODOT]) if (p && fs.existsSync(p)) return consoleTwin(p);
  for (const name of ['godot', 'godot4']) { const p = onPath(name); if (p) return consoleTwin(p); }
  const home = os.homedir();
  const roots = [path.join(home, 'Downloads'), path.join(home, 'Desktop'), path.join(home, 'Documents'),
    'C:/Program Files', 'C:/Program Files/Godot', path.join(home, 'Applications'), '/Applications'];
  const found = [];
  const look = (dir, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      const flavorOk = /mono/i.test(e.name) === Boolean(want.mono);
      if (/^godot/i.test(e.name) && /\.app$/i.test(e.name)) { if (flavorOk) found.push(path.join(p, 'Contents', 'MacOS', 'Godot')); }
      else if (e.isFile() && /^godot/i.test(e.name) && flavorOk && !/console|\.(zip|tpz)$/i.test(e.name) && (!WIN || /\.exe$/i.test(e.name))) found.push(p);
      else if (e.isDirectory() && depth > 0 && /godot/i.test(e.name)) look(p, depth - 1);
    }
  };
  for (const r of roots) look(r, 2);
  const ver = p => { const m = path.basename(p).match(/(\d+)\.(\d+)(?:\.(\d+))?/); return m ? [+m[1], +m[2], +(m[3] || 0)] : [0, 0, 0]; };
  const match = p => (want.version && ver(p).slice(0, 2).join('.') === want.version ? 1 : 0);
  found.sort((a, b) => { const [x, y] = [ver(a), ver(b)]; return (match(b) - match(a)) || (y[0] - x[0]) || (y[1] - x[1]) || (y[2] - x[2]); });
  const best = found.find(p => fs.existsSync(p));
  return best ? consoleTwin(best) : null;
}

function onPath(cmd) {
  const r = spawnSync(WIN ? 'where' : 'which', [cmd], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : null;
}

// Runs one check. A check with failOn is killed as soon as its output shows a failure,
// because a Godot script that errors before quit() would otherwise hang until the timeout.
function run(check, root) {
  if (check.missing) return Promise.resolve({ ok: false, out: check.missing, secs: 0 });
  const start = Date.now();
  return new Promise(resolve => {
    // Its own process group on Unix, so a kill reaches the real process and not just the shell.
    const child = spawn(check.cmd, { cwd: root, shell: true, detached: !WIN, env: { ...process.env, CI: '1' }, windowsHide: true });
    let out = '';
    let note = '';
    let killTimer = null;
    let done = false;
    let timedOut = false;
    const finish = status => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      const ok = (check.okCodes || [0]).includes(status) && !note && !(check.failOn && check.failOn.test(out));
      resolve({ ok, timedOut, out: note ? `${out}\n${note}` : out, secs: (Date.now() - start) / 1000, status });
    };
    const kill = msg => {
      note = msg;
      killTree(child);
      // A grandchild that escaped the kill can hold the pipes open: do not wait for it.
      setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); finish(null); }, 5000).unref();
    };
    const limit = check.timeoutMs || TIMEOUT_MS;
    const timer = setTimeout(() => { timedOut = true; kill(`TIMED OUT after ${limit / 1000}s`); }, limit);
    const onData = d => {
      out += d;
      if (out.length > 4e6) out = out.slice(-2e6);
      if (check.failOn && !killTimer && check.failOn.test(out)) killTimer = setTimeout(() => kill('stopped after the first error'), 1500);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', e => { out += String(e); finish(null); });
    child.on('close', finish);
  });
}

function killTree(child) {
  if (WIN) spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
  else try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
}

// Every source file with its size and mtime, so changes can be spotted without reading contents.
function snapshot(root) {
  let files = [];
  // -z: git quotes non-ASCII paths otherwise, and those would drop out.
  const git = spawnSync('git', ['ls-files', '-z', '-co', '--exclude-standard'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (git.status === 0) files = git.stdout.split('\0').filter(f => CODE.test(f));
  else {
    const skip = /^(\..*|node_modules|build|dist|target|out|bin|obj|__pycache__|venv|addons)$/;
    const walk = rel => {
      let entries = [];
      try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (files.length > 20000) return;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) { if (!skip.test(e.name)) walk(r); } else if (CODE.test(r)) files.push(r);
      }
    };
    walk('');
  }
  const snap = {};
  for (const f of files.sort()) {
    try { const s = fs.statSync(path.join(root, f)); snap[f] = `${s.size}:${s.mtimeMs}`; } catch { /* deleted */ }
  }
  return snap;
}

// Cheap signature of the code on disk.
function fingerprint(root, snap = snapshot(root)) {
  const h = crypto.createHash('sha1');
  for (const [f, v] of Object.entries(snap)) h.update(`${f}:${v}\n`);
  return h.digest('hex');
}

// Per-user state, so other users of a shared machine cannot plant or read it.
const stateFile = root => path.join(os.homedir(), '.cache', 'braid', `${crypto.createHash('sha1').update(path.resolve(root).toLowerCase()).digest('hex').slice(0, 16)}.json`);
const readState = root => readJson(stateFile(root)) || {};
function writeState(root, state) {
  const f = stateFile(root);
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  fs.writeFileSync(f, JSON.stringify(state));
}

function report(name, cmd, r) {
  const s = `${r.ok ? 'PASS' : 'FAIL'} ${name} (${r.secs.toFixed(1)}s)${cmd ? `  $ ${cmd}` : ''}`;
  if (r.ok) return s;
  // Drop colors and progress bars (Godot prints many), keep the tail where the errors are.
  const lines = r.out.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/).filter(l => l.trim() && !/^\s*\[\s*(\d+%|DONE)\s*\]/.test(l));
  return `${s}\n${lines.slice(-TAIL_LINES).map(l => `    ${l}`).join('\n')}`;
}

async function main() {
  const args = process.argv.slice(2);
  const root = path.resolve(args.find(a => !a.startsWith('--')) || process.cwd());
  // End of a /braid loop: the stop gate will not ask for another review of this exact code.
  if (args.includes('--reviewed')) { writeState(root, { ...readState(root), reviewed: fingerprint(root) }); console.log('braid: marked as reviewed'); return 0; }
  const fast = args.includes('--fast');
  const checks = detect(root).filter(c => !fast || FAST.test(c.name));
  if (!checks.length) { console.log('braid checks: none found (add "checks" to .claude/braid.json)'); return 3; }
  if (args.includes('--list')) { for (const c of checks) console.log(`${c.name}: ${c.cmd || c.missing}`); return 0; }
  const fp = fingerprint(root);
  let failed = 0;
  for (const c of checks) {
    const r = await run(c, root);
    if (!r.ok) failed++;
    console.log(report(c.name, c.cmd, r));
  }
  console.log(`braid checks: ${checks.length - failed} passed, ${failed} failed`);
  // A green run of everything lets the stop gate skip re-checking the same code.
  if (!failed && !fast && fp === fingerprint(root)) writeState(root, { ...readState(root), green: fp });
  return failed ? 1 : 0;
}

if (require.main === module) main().then(code => process.exit(code));

module.exports = { detect, run, report, findGodot, snapshot, fingerprint, stateFile, readState, writeState, config, FAST };
