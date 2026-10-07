import test from 'node:test';
import assert from 'node:assert/strict';
import { dependencies, mergeCandidate, reconcile } from './queue-controller.mjs';
import { appendEvent, emptyState, updateTask, validateDeveloperReview, validateState } from './queue-model.mjs';
import { BASE_POLICY } from './queue-policy.mjs';

const repo = 'workloom-ai/io-budget-test';
const head = 'a'.repeat(40), main = 'b'.repeat(40), now = 10_000_000;
const policy = { ...BASE_POLICY, hash: 'io-budget-policy', requiredNames: ['static-gate'] };
const intent = (depends_on = [], patch = {}) => `<!-- workloom-delivery\n${JSON.stringify({ ready: true, depends_on, ...patch })}\n-->`;
const pull = (number, parents = [], patch = {}) => ({ number, title: 'fix: bounded delivery scan', state: 'open', is_merged: false,
  is_wip: false, body: intent(parents), labels: [], mergeable_state: 'mergeable',
  head: { sha: head, ref: `fix/task-${number}`, repo: { path: repo } }, base: { sha: main, ref: 'main' }, ...patch });
function memoryStore(initial = emptyState(repo)) {
  let value = structuredClone(initial);
  return { read: async () => structuredClone(value), mutate: async operation => {
    const next = structuredClone(value), result = operation(next); validateState(next, repo); value = next;
    return { state: structuredClone(value), result };
  } };
}
function activated() { const state = emptyState(repo); appendEvent(state, 'activated', { policyHash: policy.hash }, now); return state; }
function snapshot(source, patch = {}) {
  return { repo, number: source.number, pull: source, headSha: source.head.sha, mainSha: main, headTime: 0,
    mergeBase: main, files: ['apps/test.ts'], checkErrors: [], checkSha: 'c'.repeat(40),
    intent: { taskId: null, ready: true, dependsOn: [], releases: [] }, ...patch };
}
function review(source) {
  return validateDeveloperReview({ schemaVersion: 1, provider: 'codex', repo, number: source.number,
    headSha: source.headSha, mainSha: source.mainSha, policyHash: policy.hash, reviewedFiles: source.files,
    dependsOn: source.intent.dependsOn, ciPolicyChanges: [], reviewedAt: new Date(now).toISOString(),
    summary: 'Fixture session proof; production still requires fresh native checks.',
    tests: [{ command: 'node --test queue-io-budget.test.mjs', exitCode: 0,
      finishedAt: new Date(now).toISOString(), result: 'Fixture checks' }] }, source, policy, now);
}

test('one scan reuses hydrated open details and reads each absent prerequisite once', async () => {
  const rows = [pull(1, [2, 90]), pull(2, [90]), pull(3, [2, 90])], calls = [];
  const map = await dependencies({ pull: async number => { calls.push(number); return pull(number, [], { state: 'closed', is_merged: true }); } }, rows, emptyState(repo));
  assert.deepEqual(calls, [90]); assert.deepEqual(map.get(1), { pending: [2], error: null });
  assert.deepEqual(map.get(2), { pending: [], error: null }); assert.deepEqual(map.get(3), { pending: [2], error: null });
});
test('current open source advancement invalidates earlier integration proof during planning', async () => {
  const state = emptyState(repo); updateTask(state, 2, { status: 'integrated', merge: { sourceSha: main } }, now);
  const result = await dependencies({}, [pull(1, [2]), pull(2)], state);
  assert.deepEqual(result.get(1).pending, [2]);
});
test('a closed absent prerequisite is read and cannot be completed from an old ledger receipt', async () => {
  const state = emptyState(repo); updateTask(state, 90, { status: 'integrated', merge: { sourceSha: head } }, now);
  let calls = 0;
  const result = await dependencies({ pull: async () => { calls++; return pull(90, [], { state: 'closed', head: { sha: main } }); } }, [pull(1, [90])], state);
  assert.equal(calls, 1); assert.deepEqual(result.get(1).pending, [90]);
});
test('40 pending sources consume one prerequisite read and zero full source snapshots', async () => {
  const rows = Array.from({ length: 40 }, (_, index) => pull(index + 1, [90]));
  let reads = 0, snapshots = 0, candidates = 0;
  const store = memoryStore(activated());
  const platform = { repo, pulls: async () => rows, pull: async () => { reads++; return pull(90, [], { state: 'closed' }); },
    snapshot: async () => { snapshots++; throw new Error('Pending source snapshot must not be requested'); },
    ensureCandidate: async () => { candidates++; }, error: error => error.message };
  const result = await reconcile({ platform, store, policy, now });
  assert.equal(reads, 1); assert.equal(snapshots, 0); assert.equal(candidates, 0); assert.equal(result.waiting.length, 40);
  assert.deepEqual(result.failed, []); assert.deepEqual(result.integrated, []);
  for (const row of rows) {
    const task = (await store.read()).tasks[String(row.number)];
    assert.equal(task.status, 'waiting_dependency'); assert.equal(task.headSha, row.head.sha);
    assert.deepEqual(task.intent.dependsOn, [90]); assert.deepEqual(task.dependencies, [90]);
  }
});
test('dry-run pending planning performs no state mutations', async () => {
  const initial = activated(), store = memoryStore(initial);
  const platform = { repo, pulls: async () => [pull(1, [90])], pull: async () => pull(90, [], { state: 'closed' }), error: error => error.message };
  const result = await reconcile({ platform, store, policy, now, dryRun: true });
  assert.equal(result.waiting.length, 1); assert.deepEqual(await store.read(), initial);
});
test('a 429 prerequisite parks only dependent sources and unrelated ready sources still get their full snapshot', async () => {
  const rows = [pull(1, [90]), pull(2)]; let calls = 0; const snapshots = [], store = memoryStore(activated());
  const platform = { repo, pulls: async () => rows, pull: async () => { calls++; throw new Error('CNB 429'); },
    snapshot: async number => { snapshots.push(number); return snapshot(rows.find(row => row.number === number)); }, error: error => error.message };
  const result = await reconcile({ platform, store, policy, now });
  assert.equal(calls, 1); assert.deepEqual(snapshots, [2]); assert.match(result.failed[0].error, /Prerequisite #90 is unreadable/);
  assert.equal((await store.read()).tasks['1'].status, 'parked'); assert.equal((await store.read()).tasks['2'].status, 'waiting_ci');
  assert.deepEqual(result.integrated, []); assert.match(result.waiting[0].reasons.join(';'), /Codex review/);
});
test('malformed intent and dependency cycles fail before snapshots without generating candidates', async () => {
  for (const rows of [[pull(1, [], { body: '<!-- workloom-delivery\ninvalid\n-->' })], [pull(1, [2]), pull(2, [1])]]) {
    let snapshots = 0;
    const platform = { repo, pulls: async () => rows, snapshot: async () => { snapshots++; }, error: error => error.message };
    const result = await reconcile({ platform, store: memoryStore(activated()), policy, now });
    assert.equal(snapshots, 0); assert.equal(result.failed.length, rows.length); assert.deepEqual(result.integrated, []);
  }
});
test('draft or explicitly unready sources retain the full existing developing-lane checks', async () => {
  for (const row of [pull(1, [90], { is_wip: true }), pull(1, [90], { body: intent([90], { ready: false }) })]) {
    let reads = 0; const store = memoryStore(activated());
    const platform = { repo, pulls: async () => [row], pull: async () => pull(90, [], { state: 'closed' }),
      snapshot: async () => { reads++; return snapshot(row, { intent: { taskId: null, ready: row.is_wip ? true : false, dependsOn: [90], releases: [] } }); },
      error: error => error.message };
    await reconcile({ platform, store, policy, now });
    assert.equal(reads, 1); assert.equal((await store.read()).tasks['1'].status, 'developing');
  }
});
test('a prerequisite becoming ready restores full checks; stale review cannot authorize the new head', async () => {
  const row = pull(1, [90]), old = snapshot(pull(1)), state = activated();
  updateTask(state, 1, { headSha: main, mainSha: main, developerReview: review(old) }, now);
  const store = memoryStore(state); let ready = false, snapshots = 0, candidates = 0;
  const platform = { repo, pulls: async () => [row], pull: async () => pull(90, [], { state: 'closed', is_merged: ready }),
    snapshot: async () => { snapshots++; return snapshot(row, { headSha: 'd'.repeat(40), pull: { ...row, head: { ...row.head, sha: 'd'.repeat(40) } }, intent: { taskId: null, ready: true, dependsOn: [90], releases: [] } }); },
    ensureCandidate: async () => { candidates++; }, error: error => error.message };
  await reconcile({ platform, store, policy, now }); assert.equal(snapshots, 0);
  ready = true;
  const result = await reconcile({ platform, store, policy, now: now + 1 });
  assert.equal(snapshots, 1); assert.equal(candidates, 0); assert.deepEqual(result.integrated, []);
  assert.match(result.waiting[0].reasons.join(';'), /Codex review/);
});
test('planning reuse never replaces the prerequisite read immediately before a merge', async () => {
  const source = snapshot(pull(1), { originNumber: 1 }), candidateNumber = 100;
  const candidate = { ...source, number: candidateNumber, pull: { ...source.pull, number: candidateNumber, head: { ...source.pull.head, ref: 'delivery/candidate/frozen' }, body: `<!-- delivery-origin:1:${head}:${main} -->` } };
  const state = activated(); updateTask(state, 1, { status: 'ready', intent: { ...source.intent, dependsOn: [90] }, originalBody: source.pull.body,
    developerReview: review(source), candidate: { number: candidateNumber, marker: `delivery-origin:1:${head}:${main}` } }, now);
  let prerequisiteReads = 0, writes = 0;
  const platform = { repo, assertCandidateProtection: async () => {}, snapshot: async () => candidate,
    pull: async number => { assert.equal(number, 90); prerequisiteReads++; return pull(90, [], { state: 'closed' }); },
    merge: async () => { writes++; }, error: error => error.message };
  await assert.rejects(mergeCandidate({ platform, store: memoryStore(state), policy, snapshot: candidate,
    dependencies: new Map([[1, { pending: [], error: null }]]), now }), /Unmerged dependencies/);
  assert.equal(prerequisiteReads, 1); assert.equal(writes, 0);
});
