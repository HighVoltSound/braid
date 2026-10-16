#!/usr/bin/env node
// Stop gate. On each user prompt (and session start): remember the code and the check commands.
// On stop: for each project whose code changed during the turn (and since its last green run),
// run the fast checks and refuse to stop while they fail. Fails open: an error here lets Claude stop.
'use strict';
// Per check; the hook itself is killed at 300 s, so the whole gate keeps under BUDGET_MS.
process.env.BRAID_TIMEOUT = process.env.BRAID_TIMEOUT || '120';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { detect, run, report, fingerprint, readState, writeState, config, FAST } = require('../scripts/checks.js');

const MAX_BLOCKS = 3;
const BUDGET_MS = 240000;

// The folder itself if it is a project, else its direct subfolders that are (e.g. GODOT_PROJECTS/<game>).
function projects(dir) {
  const isProject = d => { try { return detect(d).length > 0; } catch { return false; } };
  if (isProject(dir)) return [dir];
  let subs = [];
  try { subs = fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('.')); } catch { /* none */ }
  return subs.map(e => path.join(dir, e.name)).filter(isProject);
}

// What the gate would run. If it changes during a turn, the gate does not run it unasked.
function defs(root, checks) {
  const read = f => { try { return fs.readFileSync(path.join(root, f), 'utf8'); } catch { return ''; } };
  let scripts = '';
  try { scripts = JSON.stringify(JSON.parse(read('package.json')).scripts || {}); } catch { /* none */ }
  return crypto.createHash('sha1').update(JSON.stringify(checks.map(c => [c.name, c.cmd || ''])) + scripts + read('.claude/braid.json')).digest('hex');
}

async function gate(event, input) {
  // The project dir is stable; input.cwd follows Claude's `cd`.
  const dir = path.resolve(process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd());
  const id = input.session_id || 'default';
  const t0 = Date.now();
  const failed = [];
  const notes = [];

  for (const root of projects(dir)) {
    const mode = process.env.BRAID_GATE || config(root).gate || 'fast';
    if (mode === 'off') continue;
    const checks = detect(root);
    const fp = fingerprint(root);
    const state = readState(root);
    const s = (state.sessions || {})[id] || {};
    // Merge into a fresh read, so concurrent sessions do not erase each other.
    const save = green => {
      const cur = readState(root);
      s.t = Date.now();
      const all = Object.entries({ ...(cur.sessions || {}), [id]: s }).sort((a, b) => (b[1].t || 0) - (a[1].t || 0)).slice(0, 20);
      writeState(root, { ...cur, ...(green ? { green } : {}), sessions: Object.fromEntries(all) });
    };

    // A new turn, or no baseline yet (plugin enabled mid-session): remember, check nothing.
    if (event === 'turn' || !s.base) {
      s.base = fp;
      s.defs = defs(root, checks);
      s.blocks = 0;
      save();
      continue;
    }
    // Unchanged during this turn, since the last green run, or since the last block
    // (Claude saw the failures and chose to stop without editing): nothing to do.
    if (fp === s.base || fp === state.green || fp === s.blockedAt) continue;
    if (defs(root, checks) !== s.defs) {
      notes.push(`braid gate: the check commands in ${root} changed during this turn, so they were not run automatically. Run /braid:braid to check.`);
      continue;
    }
    if ((s.blocks || 0) >= MAX_BLOCKS) {
      notes.push(`braid gate: checks in ${root} still fail after ${MAX_BLOCKS} tries, letting Claude stop. Run /braid:braid to finish the job.`);
      continue;
    }
    const fast = checks.filter(c => !c.missing && (mode === 'all' || FAST.test(c.name)));
    if (!fast.length) continue;

    // If the hook is killed mid-run, the same code is not checked again on the next stop.
    s.blockedAt = fp;
    save();
    const fails = [];
    let complete = true;
    for (const c of fast) {
      if (Date.now() - t0 > BUDGET_MS) { complete = false; notes.push(`braid gate: out of time before "${c.name}" in ${root}.`); break; }
      const r = await run(c, root);
      if (!r.ok) fails.push(report(c.name, c.cmd, r));
    }
    // Fingerprint after the run: a check may rewrite files (lint --fix, codegen).
    const after = fingerprint(root);
    if (!fails.length) {
      delete s.blockedAt;
      save(complete && after === fp ? fp : undefined);
      continue;
    }
    s.blocks = (s.blocks || 0) + 1;
    s.blockedAt = after;
    save();
    failed.push(`[${root}]\n${fails.join('\n\n')}`);
  }

  if (failed.length) {
    return {
      decision: 'block',
      reason: `braid gate: the code changed and checks fail.\n\n${failed.join('\n\n')}\n\n` +
        'Fix the root cause (never weaken or delete a test to get green), then finish. ' +
        'If a failure was already there before your change or is outside the task, say so in one line and finish without editing.',
    };
  }
  return notes.length ? { systemMessage: notes.join('\n') } : null;
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
  readStdin()
    .then(input => gate(process.argv[2] === 'stop' ? 'stop' : 'turn', input))
    .then(out => { if (out) process.stdout.write(JSON.stringify(out)); })
    .catch(() => {})
    .finally(() => process.exit(0));
}

module.exports = { gate, projects };
