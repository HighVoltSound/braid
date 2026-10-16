#!/usr/bin/env node
// The automatic part of braid.
// start (session start) / turn (each user prompt): remember the code as it is, so only changes made
//   during Claude's turn count. At session start also hand Claude the lean-coding ladder, unless
//   ponytail already does that.
// stop: for each project whose code changed during the turn, run the fast checks and refuse to stop
//   while they fail; then, in "auto" mode, ask once per turn for the braid review loop on what changed.
//   When Claude may stop, the next turn starts from here, whatever starts it.
// Fails open: an error in here lets Claude stop.
'use strict';
// Per check; the hook itself is killed at 300 s, so the whole gate keeps under BUDGET_MS.
process.env.BRAID_TIMEOUT = process.env.BRAID_TIMEOUT || '120';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { detect, run, report, snapshot, fingerprint, stateFile, readState, writeState, config, FAST } = require('../scripts/checks.js');

const MAX_BLOCKS = 3;
const BUDGET_MS = 240000;
const MAX_SNAP = 5000; // files; bigger projects get no per-file change list
const MAX_LISTED = 40;
const MARKERS = /^(project\.godot|package\.json|deno\.jsonc?|pyproject\.toml|requirements\.txt|setup\.py|Cargo\.toml|go\.mod|pom\.xml|build\.gradle(\.kts)?|Package\.swift|pubspec\.yaml|mix\.exs|Gemfile|composer\.json|Makefile|CMakeLists\.txt|.+\.(csproj|sln))$/;
const LADDER = 'braid autopilot is on. When you write code, make the smallest complete change: skip what nobody asked for, ' +
  'reuse what the project already has, then the standard library or engine, then an installed dependency, then one clear line, ' +
  'and only then the minimum new code. No abstraction, option or config nobody asked for. Reach every caller, scene and test ' +
  'the change touches, and give new non-trivial logic one small test.';

// The folder itself if it is a project, else its direct subfolders that are (e.g. GODOT_PROJECTS/<game>).
// A project has checks or at least a project file: code without checks still gets reviewed.
function projects(dir) {
  const isProject = d => {
    try { return detect(d).length > 0 || fs.readdirSync(d).some(f => MARKERS.test(f)); } catch { return false; }
  };
  if (isProject(dir)) return [dir];
  let subs = [];
  try { subs = fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('.')); } catch { /* none */ }
  return subs.map(e => path.join(dir, e.name)).filter(isProject);
}

// What the gate would run on its own. If it changes during a turn, the gate does not run it unasked.
function defs(root, checks) {
  const read = f => { try { return fs.readFileSync(path.join(root, f), 'utf8'); } catch { return ''; } };
  let scripts = '';
  try { scripts = JSON.stringify(JSON.parse(read('package.json')).scripts || {}); } catch { /* none */ }
  const fast = checks.filter(c => FAST.test(c.name)).map(c => [c.name, c.cmd || '']);
  return crypto.createHash('sha1').update(JSON.stringify(fast) + scripts + read('.claude/braid.json')).digest('hex');
}

// The project's files as they were when this session's turn began, to list what the turn changed.
const snapFile = (root, id) => stateFile(root).replace(/\.json$/, `.${crypto.createHash('sha1').update(id).digest('hex').slice(0, 8)}.snap.json`);
function saveSnap(root, id, snap) {
  const f = snapFile(root, id);
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  fs.writeFileSync(f, Object.keys(snap).length <= MAX_SNAP ? JSON.stringify(snap) : 'null');
  for (const name of fs.readdirSync(path.dirname(f))) {
    const p = path.join(path.dirname(f), name);
    try { if (name.endsWith('.snap.json') && Date.now() - fs.statSync(p).mtimeMs > 7 * 864e5) fs.unlinkSync(p); } catch { /* gone */ }
  }
}
function changedFiles(root, id, now) {
  let before = null;
  try { before = JSON.parse(fs.readFileSync(snapFile(root, id), 'utf8')); } catch { /* none */ }
  if (!before) return null;
  return [...new Set([...Object.keys(before), ...Object.keys(now)])].filter(f => before[f] !== now[f]).map(f => (f in now ? f : `${f} (deleted)`));
}

function ponytailOn(dir) {
  const on = f => {
    try { return Object.entries(JSON.parse(fs.readFileSync(f, 'utf8')).enabledPlugins || {}).some(([k, v]) => k.startsWith('ponytail@') && v); } catch { return false; }
  };
  const home = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return [path.join(home, 'settings.json'), path.join(dir, '.claude', 'settings.json'), path.join(dir, '.claude', 'settings.local.json')].some(on);
}

async function gate(event, input) {
  // The project dir is stable; input.cwd follows Claude's `cd`.
  const dir = path.resolve(process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd());
  const id = input.session_id || 'default';
  const t0 = Date.now();
  if (event === 'context') return context(dir);

  // When this session's turn began, for projects that appear during the turn.
  const dirState = readState(dir);
  const turnStart = (dirState.turns || {})[id];
  if (event !== 'stop') {
    const turns = Object.entries({ ...(dirState.turns || {}), [id]: t0 }).sort((a, b) => b[1] - a[1]).slice(0, 20);
    writeState(dir, { ...readState(dir), turns: Object.fromEntries(turns) });
  }

  const failed = [];
  const review = [];
  const notes = [];
  const seen = [];

  for (const root of projects(dir)) {
    const mode = process.env.BRAID_GATE || config(root).gate || 'auto';
    if (mode === 'off') continue;
    const checks = detect(root);
    const snap = snapshot(root);
    const fp = fingerprint(root, snap);
    const state = readState(root);
    const s = (state.sessions || {})[id] || {};
    // Merge into a fresh read, so concurrent sessions do not erase each other.
    const save = green => {
      const cur = readState(root);
      s.t = Date.now();
      const all = Object.entries({ ...(cur.sessions || {}), [id]: s }).sort((a, b) => (b[1].t || 0) - (a[1].t || 0)).slice(0, 20);
      writeState(root, { ...cur, ...(green ? { green } : {}), sessions: Object.fromEntries(all) });
    };
    const rebase = (base = fp, baseSnap = snap) => {
      Object.assign(s, { base, defs: defs(root, checks), blocks: 0, reviewAsked: false });
      delete s.blockedAt;
      save();
      saveSnap(root, id, baseSnap);
    };

    if (event === 'start') { rebase(); s.done = true; save(); continue; }
    if (event === 'turn') {
      // The last turn never reached a clean stop (interrupted): keep its baseline, so its edits still count.
      if (s.base && s.done === false) Object.assign(s, { blocks: 0, reviewAsked: false });
      else rebase();
      s.done = false;
      save();
      continue;
    }

    if (!s.base) {
      // No baseline: the plugin was enabled mid-session (nothing to compare with), or the project
      // appeared during this turn (files older than the turn are the baseline).
      if (!turnStart) { rebase(); continue; }
      const older = Object.fromEntries(Object.entries(snap).filter(([, v]) => Number(v.split(':')[1]) < turnStart));
      rebase(fingerprint(root, older), older);
    }
    seen.push({ root, s, save, rebase });
    if (fp === s.base) continue;

    // 1. Fast checks, unless this code already passed them or Claude already saw it fail.
    const fast = checks.filter(c => !c.missing && (mode === 'all' || FAST.test(c.name)));
    if (defs(root, checks) !== s.defs) {
      notes.push(`braid gate: the check commands in ${root} changed during this turn, so they were not run automatically. Run /braid:braid to check.`);
    } else if (fast.length && fp !== state.green && fp !== s.blockedAt) {
      // If the hook is killed mid-run, the same code is not checked again on the next stop.
      s.blockedAt = fp;
      save();
      const fails = [];
      let complete = true;
      for (const c of fast) {
        if (Date.now() - t0 > BUDGET_MS) { complete = false; notes.push(`braid gate: out of time before "${c.name}" in ${root}.`); break; }
        const r = await run(c, root);
        if (r.timedOut) { complete = false; notes.push(`braid gate: "${c.name}" in ${root} took longer than ${process.env.BRAID_TIMEOUT}s, so it was not checked.`); }
        else if (!r.ok) fails.push(report(c.name, c.cmd, r));
      }
      // Fingerprint after the run: a check may rewrite files (lint --fix, codegen).
      const after = fingerprint(root);
      if (fails.length) {
        s.blockedAt = after;
        if ((s.blocks || 0) >= MAX_BLOCKS) {
          notes.push(`braid gate: checks in ${root} still fail after ${MAX_BLOCKS} tries this turn, letting Claude stop. Run /braid:braid to finish the job.`);
        } else {
          s.blocks = (s.blocks || 0) + 1;
          failed.push(`[${root}]\n${fails.join('\n\n')}`);
        }
        save();
        continue; // review only after the checks pass
      }
      delete s.blockedAt;
      save(complete && after === fp ? fp : undefined);
    }

    // 2. The review loop, at most once per turn.
    if (mode === 'auto' && !s.reviewAsked && fp !== state.reviewed) review.push({ root, s, save, files: changedFiles(root, id, snap) });
  }

  if (failed.length) {
    return {
      decision: 'block',
      reason: `braid gate: the code changed and checks fail.\n\n${failed.join('\n\n')}\n\n` +
        'Fix the root cause (never weaken or delete a test to get green), then finish. ' +
        'An error in a file you did not edit can still come from your change (a changed signature, export or scene). ' +
        'If a failure was already there before your change, say so in one line and finish without editing.',
    };
  }
  if (review.length) {
    for (const r of review) { r.s.reviewAsked = true; r.save(); }
    const scope = review.map(({ root, files }) => {
      if (!files) return `${root}: the files you changed in this turn`;
      const more = files.length > MAX_LISTED ? ` and ${files.length - MAX_LISTED} more` : '';
      return `${root}: ${files.slice(0, MAX_LISTED).join(', ')}${more}`;
    }).join('; ');
    return {
      decision: 'block',
      reason: `braid autopilot: these code files changed on disk during this turn: ${scope}. ` +
        `Before finishing, review the edits you made in them: call the Skill tool with skill "braid:braid" and args "turn: ${scope}". ` +
        'Finish without the review only if: you made none of these edits (they are the user\'s: leave them and say so in one line); ' +
        'your edits only touch comments or formatting; you cannot continue without the user\'s answer (not a closing offer of optional extra work); ' +
        'or you are inside a /braid run that has not reached its report (continue it: it ends with its own review).',
    };
  }
  // Claude may stop: the next turn starts from here, whatever starts it (a prompt or a background notification).
  for (const p of seen) {
    const now = snapshot(p.root);
    p.rebase(fingerprint(p.root, now), now);
    p.s.done = true;
    p.save();
  }
  return notes.length ? { systemMessage: notes.join('\n') } : null;
}

// Session start: the ladder, unless the gate is off or ponytail is already injecting its own rules.
function context(dir) {
  if (process.env.BRAID_GATE === 'off' || ponytailOn(dir)) return null;
  return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: LADDER } };
}

function readStdin() {
  // Windows can leave stdin open forever: give up after a second.
  return new Promise(resolve => {
    let data = '';
    const done = () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } };
    setTimeout(done, 1000);
    process.stdin.on('data', d => { data += d; });
    process.stdin.on('end', done);
    process.stdin.on('error', done);
  });
}

if (require.main === module) {
  const event = process.argv[2];
  readStdin()
    .then(async input => {
      if (event === 'start') {
        await gate('start', input);
        return gate('context', input);
      }
      return gate(['stop', 'context'].includes(event) ? event : 'turn', input);
    })
    .then(out => { if (out) process.stdout.write(JSON.stringify(out)); })
    .catch(() => {})
    .finally(() => process.exit(0));
}

module.exports = { gate, projects };
