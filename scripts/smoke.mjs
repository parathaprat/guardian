#!/usr/bin/env node
/**
 * End-to-end smoke test.
 *
 * Boots nothing — assumes the API is already running (`npm run dev:server`).
 * Exercises the full loop: snapshot -> stream -> inject -> decision -> feedback
 * -> reflection -> eval, and asserts the shapes the UI depends on.
 *
 *   node scripts/smoke.mjs [baseUrl]
 */

const BASE = process.argv[2] ?? 'http://127.0.0.1:8787';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(t) {
  console.log(`\n\x1b[1m${t}\x1b[0m`);
}

async function json(path, init) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Collect SSE events for `ms`, returning them grouped by type. */
async function collectStream(ms) {
  const ctl = new AbortController();
  const seen = [];
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(`${BASE}/api/stream`, { signal: ctl.signal });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const chunks = buf.split('\n\n');
      buf = chunks.pop() ?? '';
      for (const chunk of chunks) {
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data:')) continue;
          try { seen.push(JSON.parse(line.slice(5).trim())); } catch { /* heartbeat */ }
        }
      }
    }
  } catch {
    /* aborted — expected */
  } finally {
    clearTimeout(timer);
  }
  return seen;
}

async function main() {
  console.log(`\n\x1b[1mSENTRY smoke test\x1b[0m  →  ${BASE}\n${'─'.repeat(52)}`);

  section('1. Snapshot');
  const snap = await json('/api/snapshot');
  check('GET /api/snapshot returns 200', snap.status === 200, `got ${snap.status}`);
  const s = snap.body;
  check('has world with sites', Array.isArray(s?.world?.sites) && s.world.sites.length > 0);
  check('has zones', Array.isArray(s?.world?.zones) && s.world.zones.length >= 10,
    `${s?.world?.zones?.length} zones`);
  check('has guards', Array.isArray(s?.world?.guards) && s.world.guards.length > 0);
  check('has robots', Array.isArray(s?.world?.robots) && s.world.robots.length > 0);
  check('has engine status', typeof s?.engine?.engine === 'string');
  check('has controls with seed', typeof s?.controls?.seed === 'number');
  check('has metrics object', s?.metrics && typeof s.metrics.dispatchScore === 'number');
  check('playbook is seeded', Array.isArray(s?.playbook));

  // Ground-truth leak check — the single most important invariant.
  section('2. Ground-truth containment');
  const unresolved = (s?.incidents ?? []).filter((i) => i.outcome === null);
  check('no revealedTruth on unresolved incidents',
    unresolved.every((i) => i.revealedTruth === null),
    `${unresolved.filter((i) => i.revealedTruth !== null).length} leaked`);
  const feedStr = JSON.stringify(s?.feed ?? []);
  check('event feed carries no isReal field', !feedStr.includes('"isReal"'));
  check('event feed carries no trueSeverity field', !feedStr.includes('"trueSeverity"'));

  section('3. Simulation control');
  check('POST /api/sim/start', (await json('/api/sim/start', { method: 'POST' })).status === 200);
  const spd = await json('/api/sim/speed', { method: 'POST', body: JSON.stringify({ speed: 64 }) });
  check('POST /api/sim/speed', spd.status === 200);
  const badSpeed = await json('/api/sim/speed', { method: 'POST', body: JSON.stringify({ speed: 'fast' }) });
  check('bad speed payload rejected with 4xx', badSpeed.status >= 400 && badSpeed.status < 500,
    `got ${badSpeed.status}`);

  section('4. Live stream');
  // Inject while the stream is open rather than betting on the arrival process —
  // a test that depends on a Poisson draw is a flaky test.
  const zone0 = s.world.zones[0];
  const collecting = collectStream(9000);
  await sleep(1200);
  await json('/api/sim/inject', {
    method: 'POST', body: JSON.stringify({ type: 'loitering', zoneId: zone0.id }),
  });
  const events = await collecting;
  const types = new Set(events.map((e) => e.type));
  check('stream delivered events', events.length > 0, `${events.length} frames`);
  check('stream opened with a snapshot', events[0]?.type === 'snapshot');
  check('received security events', types.has('event'), [...types].join(','));
  check('received incident updates', types.has('incident'), [...types].join(','));
  check('every frame has a type field', events.every((e) => typeof e.type === 'string'));

  section('5. Injection + agent decision');
  const zone = s.world.zones.find((z) => z.kind === 'loading_dock') ?? s.world.zones[0];
  const inj = await json('/api/sim/inject', {
    method: 'POST',
    body: JSON.stringify({ type: 'panic_button', zoneId: zone.id }),
  });
  check('POST /api/sim/inject', inj.status === 200, `got ${inj.status}`);
  await sleep(4000);
  const after = (await json('/api/snapshot')).body;
  const injected = (after.incidents ?? []).find((i) => i.event.type === 'panic_button');
  check('injected event became an incident', !!injected);
  if (injected) {
    check('incident carries a decision', !!injected.decision,
      `status=${injected.status}`);
    check('decision has an action', !!injected.decision?.action);
    check('trace has steps', (injected.trace?.length ?? 0) > 0,
      `${injected.trace?.length} steps`);
    check('decision cites evidence', (injected.decision?.evidence?.length ?? 0) > 0);
    check('panic_button was not suppressed', injected.decision?.action !== 'suppress',
      `action=${injected.decision?.action}`);
  }

  section('6. Operator feedback');
  const target = (after.incidents ?? []).find((i) => i.decision);
  if (target) {
    const fb = await json(`/api/incidents/${target.id}/feedback`, {
      method: 'POST',
      body: JSON.stringify({ verdict: 'confirm', operator: 'smoke-test' }),
    });
    check('POST feedback accepted', fb.status === 200, `got ${fb.status}`);
    await sleep(400);
    const re = (await json('/api/snapshot')).body;
    const updated = (re.incidents ?? []).find((i) => i.id === target.id);
    check('feedback persisted on the incident', !!updated?.feedback);
  } else {
    check('an incident with a decision exists to give feedback on', false);
  }
  const badFb = await json('/api/incidents/does-not-exist/feedback', {
    method: 'POST', body: JSON.stringify({ verdict: 'confirm' }),
  });
  check('feedback on unknown incident 4xx', badFb.status >= 400 && badFb.status < 500,
    `got ${badFb.status}`);

  section('7. Reflection');
  const refl = await json('/api/playbook/reflect', { method: 'POST' });
  check('POST /api/playbook/reflect', refl.status === 200, `got ${refl.status}`);
  check('proposal has a summary', typeof refl.body?.summary === 'string');
  check('proposal is pending', refl.body?.status === 'pending');
  check('proposal has rules or retirements',
    Array.isArray(refl.body?.rules) && Array.isArray(refl.body?.retire));

  section('8. Eval harness');
  const t0 = Date.now();
  const ev = await json('/api/evals/run', {
    method: 'POST',
    body: JSON.stringify({ eventCount: 120, useClaude: false }),
  });
  check('POST /api/evals/run', ev.status === 200, `got ${ev.status}`);
  const run = ev.body;
  check('run has three arms', run?.arms?.length === 3, `${run?.arms?.length}`);
  check('arms are static/cold/learned',
    ['static', 'cold', 'learned'].every((id) => run?.arms?.some((a) => a.id === id)));
  check('every arm has metrics', run?.arms?.every((a) => typeof a.metrics?.dispatchScore === 'number'));
  check('delta computed', run?.delta && Object.keys(run.delta).length > 0);
  check('notes explain methodology', (run?.notes?.length ?? 0) > 40);
  check('no NaN in any metric',
    !JSON.stringify(run?.arms ?? []).includes('null') || run.arms.every(
      (a) => Object.values(a.metrics).every((v) => typeof v === 'number' && Number.isFinite(v))));
  console.log(`    \x1b[2m(eval took ${((Date.now() - t0) / 1000).toFixed(1)}s)\x1b[0m`);

  const learned = run?.arms?.find((a) => a.id === 'learned');
  const staticArm = run?.arms?.find((a) => a.id === 'static');
  if (learned && staticArm) {
    console.log(
      `    \x1b[2mdispatchScore  static ${staticArm.metrics.dispatchScore.toFixed(1)}` +
      `  →  learned ${learned.metrics.dispatchScore.toFixed(1)}\x1b[0m`);

    // Deliberately NOT asserted here: "learned beats static".
    //
    // A console eval trains its learned arm from the *live* memory, which in a
    // smoke run is a few minutes old, over 120 events. Whether that clears a
    // static table is a genuine coin flip at that sample size — asserting it
    // would be a test that fails for reasons unrelated to the code, and the
    // temptation would then be to weaken it until it passed.
    //
    // The learning claim is verified where it is actually measurable:
    // `npm run eval -- --seed N --events 400`, across several seeds, with a
    // warm-up stream disjoint from the scored one. See docs/METRICS.md.
    check('learned arm is scored on the same scale as static',
      Number.isFinite(learned.metrics.dispatchScore)
      && learned.metrics.dispatchScore >= 0 && learned.metrics.dispatchScore <= 100,
      `${learned.metrics.dispatchScore}`);
  }

  section('9. Robustness');
  check('unknown route 404s', (await json('/api/nope')).status === 404);
  const malformed = await fetch(`${BASE}/api/sim/speed`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{{{',
  });
  check('malformed JSON does not 500', malformed.status !== 500, `got ${malformed.status}`);
  check('server still alive after abuse', (await json('/api/snapshot')).status === 200);

  console.log(`\n${'─'.repeat(52)}`);
  if (fail === 0) {
    console.log(`\x1b[32m\x1b[1mALL ${pass} CHECKS PASSED\x1b[0m\n`);
  } else {
    console.log(`\x1b[31m\x1b[1m${fail} FAILED\x1b[0m / ${pass + fail} checks`);
    for (const f of failures) console.log(`  \x1b[31m·\x1b[0m ${f}`);
    console.log('');
  }
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\n\x1b[31mSmoke test could not run:\x1b[0m', err.message);
  console.error('Is the API running?  npm run dev:server\n');
  process.exit(2);
});
