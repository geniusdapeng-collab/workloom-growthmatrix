import test from 'node:test';
import assert from 'node:assert/strict';
import { Platform } from './queue-platform.mjs';
import { dependencies, reconcile } from './queue-controller.mjs';
import { appendEvent, emptyState, parseIntent, updateTask, validateState } from './queue-model.mjs';
import { BASE_POLICY } from './queue-policy.mjs';

const repo = 'workloom-ai/read-isolation-fixture';
const head = 'a'.repeat(40), main = 'b'.repeat(40), tested = 'c'.repeat(40), now = 10_000_000;
const policy = { ...BASE_POLICY, hash: 'read-isolation-policy', requiredNames: ['static-gate'] };
const intent = parents => `<!-- workloom-delivery\n${JSON.stringify({ ready: true, depends_on: parents })}\n-->`;
const pull = (number, parents = [], patch = {}) => ({ number, title: 'fix: independent source', state: 'open',
  is_wip: false, is_merged: false, labels: [], body: intent(parents), mergeable_state: 'mergeable',
  head: { sha: head, ref: `fix/source-${number}`, repo: { path: repo } }, base: { sha: main, ref: 'main' }, ...patch });
function memoryStore(initial) {
  let value = structuredClone(initial);
  return { read: async () => structuredClone(value), mutate: async operation => {
    const next = structuredClone(value), result = operation(next);
    validateState(next, repo); value = next; return { state: structuredClone(value), result };
  } };
}
function activated() {
  const state = emptyState(repo); appendEvent(state, 'activated', { policyHash: policy.hash }, now); return state;
}
function platformFixture(rows, failures = new Map()) {
  const calls = [];
  const platform = new Platform(repo, 'fixture-secret', async (_repo, path, options) => {
    calls.push({ path, method: options.method ?? 'GET' });
    assert.equal(options.method ?? 'GET', 'GET', 'No candidate, merge or paid build is allowed by this fixture');
    if (path.startsWith('/-/pulls?')) return rows.filter(row => row.state === 'open').map(row => ({ ...row, body: '' }));
    const detail = /^\/-\/pulls\/(\d+)$/.exec(path);
    if (detail) {
      const number = Number(detail[1]);
      if (failures.has(number)) {
        const failure = failures.get(number);
        if (failure instanceof Error) throw failure;
        return structuredClone(failure);
      }
      return structuredClone(rows.find(row => row.number === number));
    }
    if (path === '/-/git/branches/main') return { commit: { sha: main } };
    if (path === `/-/git/compare/${main}...${head}`) return { base_commit: { sha: main }, head_commit: { sha: head },
      merge_base_commit: { sha: main }, files: [{ path: 'apps/source.ts' }] };
    if (path === `/-/git/commits/${head}`) return { sha: head, commit: { committer: { date: new Date(0).toISOString() } } };
    if (path === `/-/git/commits/${tested}`) return { sha: tested, parents: [{ sha: main }, { sha: head }] };
    if (/^\/-\/pulls\/\d+\/commit-statuses$/.test(path)) return { sha: tested,
      statuses: [{ context: 'cnb/pull_request/test(static-gate)', state: 'success' }] };
    if (path.startsWith('/-/issues?')) return [];
    throw new Error(`Unexpected actual Platform fixture path ${path}`);
  }, { minIntervalMs: 0 });
  return { platform, calls };
}

for (const status of [429, 403, 404]) test(`strict default propagates HTTP ${status}; opted-in scan isolates only its known PR`, async () => {
  const failure = Object.assign(new Error(`CNB ${status}`), { status });
  const { platform, calls } = platformFixture([pull(1), pull(2)], new Map([[1, failure]]));
  await assert.rejects(platform.pulls(), error => error === failure);
  assert.ok(!calls.some(call => call.path === '/-/pulls/2'));
  calls.length = 0; const rejected = [];
  const actual = await platform.pulls({ onReadError: entry => rejected.push(entry) });
  assert.deepEqual(actual.map(row => row.number), [2]);
  assert.equal(actual[0].body, intent([])); assert.equal(rejected.length, 1);
  assert.equal(rejected[0].number, 1); assert.equal(rejected[0].error, failure);
  assert.deepEqual(calls.map(call => call.path), ['/-/pulls?state=open&base_ref=main&page_size=100&page=1', '/-/pulls/1', '/-/pulls/2']);
});
for (const [name, bad, reason] of [
  ['mismatched identity', pull(99), /identity/],
  ['missing body', { ...pull(1), body: undefined }, /body/],
  ['object body', { ...pull(1), body: { ready: true } }, /body/],
]) test(`an unreadable ${name} cannot use a list summary as delivery intent`, async () => {
  const { platform } = platformFixture([pull(1, [90]), pull(2)], new Map([[1, bad]]));
  const failed = [], actual = await platform.pulls({ onReadError: entry => failed.push(entry) });
  assert.deepEqual(actual.map(row => row.number), [2]); assert.match(failed[0].error.message, reason);
});
test('failure handlers must be valid before IO and their own failures remain fatal', async () => {
  const { platform, calls } = platformFixture([pull(1)], new Map([[1, new Error('CNB 429')]]));
  await assert.rejects(platform.pulls({ onReadError: true }), /handler/); assert.deepEqual(calls, []);
  const failure = new Error('Cannot record a rejected PR');
  await assert.rejects(platform.pulls({ onReadError: async () => { throw failure; } }), error => error === failure);
});
test('incomplete list pagination stays fatal before any detail or delivery planning', async () => {
  const calls = [], rejected = [];
  const platform = new Platform(repo, 'fixture', async (_repo, path) => {
    calls.push(path);
    if (path.endsWith('page=1')) return Array.from({ length: 100 }, (_, index) => ({ number: index + 1 }));
    throw new Error('CNB 429 second list page');
  }, { minIntervalMs: 0 });
  await assert.rejects(platform.pulls({ onReadError: entry => rejected.push(entry) }), /second list page/);
  assert.equal(calls.length, 2); assert.deepEqual(rejected, []);
});
for (const rows of [[{ number: 0 }], [{ number: 'not-a-number' }], [{ number: 1 }, { number: 1 }]]) {
  test(`ambiguous list identities remain fatal (${JSON.stringify(rows)})`, async () => {
    const calls = [], rejected = [];
    const platform = new Platform(repo, 'fixture', async (_repo, path) => { calls.push(path); return rows; }, { minIntervalMs: 0 });
    await assert.rejects(platform.pulls({ onReadError: entry => rejected.push(entry) }), /identity/);
    assert.equal(calls.length, 1); assert.deepEqual(rejected, []);
  });
}
test('an unreadable parent cannot reuse an old integration receipt or be read a second time in the scan', async () => {
  const state = activated(); updateTask(state, 1, { status: 'integrated', merge: { sourceSha: head } }, now);
  const reads = [];
  const map = await dependencies({ pull: async number => { reads.push(number); return pull(number, [], { is_merged: true }); } },
    [pull(2, [1]), pull(3)], state, new Map([[1, 'CNB 429']]));
  assert.deepEqual(reads, []); assert.deepEqual(map.get(2), { pending: [1], error: 'Prerequisite #1 is unreadable: CNB 429' });
  assert.deepEqual(map.get(3), { pending: [], error: null });
});
test('actual Platform 429 isolation persists failure and allows full independent source checks', async () => {
  const state = activated(); updateTask(state, 1, { status: 'integrated', headSha: head, merge: { sourceSha: head } }, now);
  const store = memoryStore(state), { platform, calls } = platformFixture([pull(1), pull(2, [1]), pull(3)],
    new Map([[1, new Error('CNB 429 fixture-secret')]]));
  const result = await reconcile({ platform, store, policy, now });
  assert.deepEqual(result.failed.map(row => [row.number, row.stage]), [[1, 'pull-detail'], [2, 'task']]);
  assert.ok(!JSON.stringify(result).includes('fixture-secret')); assert.match(result.failed[0].error, /REDACTED/);
  assert.equal(calls.filter(call => call.path === '/-/pulls/1').length, 1);
  assert.ok(!calls.some(call => call.path === '/-/pulls/2/commit-statuses'));
  assert.ok(calls.some(call => call.path === '/-/pulls/3/commit-statuses'));
  assert.equal(calls.filter(call => call.path === '/-/pulls/3').length, 3, 'Hydration, snapshot start and final snapshot each read current source');
  assert.deepEqual(result.integrated, []); assert.match(result.waiting.find(row => row.number === 3).reasons.join(';'), /Codex review/);
  const after = await store.read(); assert.equal(after.tasks['1'].status, 'parked');
  assert.equal(after.tasks['1'].headSha, head); assert.equal(after.tasks['1'].merge.sourceSha, head);
  assert.equal(after.tasks['2'].status, 'parked'); assert.equal(after.tasks['3'].status, 'waiting_ci');
  assert.ok(!JSON.stringify(after).includes('fixture-secret'));
});
test('dry-run isolation reports all errors without altering any durable identity or event', async () => {
  const state = activated(), store = memoryStore(state), { platform } = platformFixture([pull(1), pull(2, [1]), pull(3)],
    new Map([[1, new Error('CNB 403')]]));
  const result = await reconcile({ platform, store, policy, now, dryRun: true });
  assert.equal(result.failed.length, 2); assert.deepEqual(result.integrated, []);
  assert.deepEqual(await store.read(), state);
});
test('a later scan reads recovered current details again; stale source reviews still grant no delivery', async () => {
  const state = activated(), store = memoryStore(state);
  const failures = new Map([[1, new Error('CNB 429')]]);
  const rows = [pull(1), pull(2, [1]), pull(3)], { platform, calls } = platformFixture(rows, failures);
  await reconcile({ platform, store, policy, now });
  failures.delete(1); rows[0] = pull(1, [], { state: 'closed', is_merged: true }); calls.length = 0;
  const result = await reconcile({ platform, store, policy, now: now + 11 * 60_000 });
  assert.equal(calls.filter(call => call.path === '/-/pulls/1').length, 1);
  assert.ok(calls.some(call => call.path === '/-/pulls/2/commit-statuses'));
  assert.deepEqual(result.failed, []); assert.deepEqual(result.integrated, []);
  assert.match(result.waiting.find(row => row.number === 2).reasons.join(';'), /Codex review/);
});

test('unchanged waiting tasks cannot consume the deadline before a newer independent source is checked', async () => {
  const state = activated();
  const waiting = Array.from({ length: 20 }, (_, index) => pull(index + 1, [90]));
  for (const row of waiting) updateTask(state, row.number, { status: 'waiting_dependency',
    headSha: row.head.sha, intent: parseIntent(row), dependencies: [90] }, now);
  const store = memoryStore(state), mutate = store.mutate;
  let elapsed = 0, writes = 0;
  store.mutate = async operation => { writes++; elapsed += 2000; return mutate(operation); };
  const { platform, calls } = platformFixture([...waiting, pull(21), pull(90, [], { state: 'closed' })]);
  const result = await reconcile({ platform, store, policy, now: now + 1,
    deadlineMs: 1000, elapsedClock: () => elapsed });
  assert.equal(calls.filter(call => call.path === '/-/pulls/90').length, 1, 'Current prerequisite is still read');
  assert.ok(calls.some(call => call.path === '/-/pulls/21/commit-statuses'), 'Independent source receives real full snapshot checks');
  assert.equal(writes, 1, 'Only the newly inspected independent source changes durable state');
  assert.match(result.waiting.find(row => row.number === 21).reasons.join(';'), /Codex review/);
  assert.deepEqual(result.integrated, []);
  const after = await store.read();
  for (const row of waiting) assert.deepEqual(after.tasks[String(row.number)], state.tasks[String(row.number)]);
});

for (const changed of ['head', 'intent', 'pending dependencies', 'missing intent', 'missing pending dependencies']) test(`changed ${changed} is persisted despite waiting-write suppression`, async () => {
  const current = pull(1, [90, 91]), state = activated();
  const old = { status: 'waiting_dependency', headSha: head, intent: parseIntent(current), dependencies: [90] };
  if (changed === 'head') old.headSha = 'd'.repeat(40);
  if (changed === 'intent') old.intent = parseIntent(pull(1, [90]));
  if (changed === 'pending dependencies') old.dependencies = [90, 91];
  if (changed === 'missing intent') delete old.intent;
  if (changed === 'missing pending dependencies') delete old.dependencies;
  updateTask(state, 1, old, now);
  const store = memoryStore(state), { platform, calls } = platformFixture([current,
    pull(90, [], { state: 'closed' }), pull(91, [], { state: 'closed', is_merged: true })]);
  const result = await reconcile({ platform, store, policy, now: now + 1 });
  const after = await store.read();
  assert.equal(after.revision, state.revision + 1);
  assert.equal(after.tasks['1'].headSha, current.head.sha);
  assert.deepEqual(after.tasks['1'].intent, parseIntent(current));
  assert.deepEqual(after.tasks['1'].dependencies, [90]);
  assert.equal(after.tasks['1'].updatedAt, now + 1);
  assert.ok(!calls.some(call => call.path === '/-/pulls/1/commit-statuses'));
  assert.deepEqual(result.integrated, []);
});
