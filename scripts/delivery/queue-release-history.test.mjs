import test from 'node:test';
import assert from 'node:assert/strict';
import { appendEvent, emptyState, validateState } from './queue-model.mjs';
import { enqueueReleases, reconcileReleases } from './queue-release.mjs';

const repo = 'workloom-ai/workloom-growthmatrix', sha = 'a'.repeat(40), version = 'v0.1.3';
function fixture({ parked = false, history = { total: '0', data: [] }, alteration } = {}) {
  let state = emptyState(repo);
  enqueueReleases(state, repo, { number: 1, merge: { sha }, intent: { releases: [{ kind: 'desktop', version }] } }, 1);
  const key = Object.keys(state.releases)[0];
  if (parked) Object.assign(state.releases[key], { status: 'parked', attempts: 0,
    error: 'Release build history unreadable', tag: { name: version, sha } });
  if (alteration) alteration(state.releases[key], state);
  let starts = 0;
  const store = { read: async () => structuredClone(state), mutate: async operation => {
    const next = structuredClone(state), result = operation(next); validateState(next, repo);
    state = next; return { state: structuredClone(state), result };
  } };
  const platform = { repo, error: error => error.message, call: async (path, options) => {
    if (path.includes('/git/tags/')) return { name: version, commit: { sha } };
    if (path.includes('/build/logs')) return history;
    if (path === '/-/build/start') {
      starts++; assert.equal(options.body.sha, sha); assert.equal(options.body.env.RELEASE_TAG, version);
      assert.ok(state.events.some(event => event.kind === 'release_launch_intent' && event.data.key === key));
      return { success: true, sn: 'acknowledged-native-build' };
    }
    if (path.includes('/build/status/')) return { status: 'pending' };
    throw new Error(`Unexpected API path ${path}`);
  } };
  return { key, platform, store, starts: () => starts, current: () => structuredClone(state) };
}

test('observed native string zero and documented integer zero each permit exactly one acknowledged launch', async () => {
  for (const total of ['0', 0]) {
    const f = fixture({ history: { init: '1', total, data: [], timestamp: 1791380799805 } });
    assert.equal((await reconcileReleases({ ...f, now: 2 }))[0].status, 'running');
    await reconcileReleases({ ...f, now: 3 });
    assert.equal(f.starts(), 1);
  }
});

test('invalid, incomplete, unbounded or repeated history refuses a deployment before POST', async () => {
  const invalid = [null, undefined, false, true, '', ' ', '00', '01', '0.0', '1e2', '-1', '-0', 'NaN',
    '9007199254740992', -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY];
  const histories = invalid.map(total => ({ total, data: [] }));
  histories.push({ total: '101', data: [] }, { total: '1', data: [] }, { total: 0, data: [{ sn: 'one' }] },
    { total: '2', data: [{ sn: 'same' }, { sn: 'same' }] }, { total: '1', data: [null] },
    { total: 1, data: [{ sn: '' }] }, { total: 0, data: null });
  for (const history of histories) {
    const f = fixture({ history });
    assert.equal((await reconcileReleases({ ...f, now: 2 }))[0].status, 'parked');
    assert.equal(f.starts(), 0);
    assert.ok(!f.current().events.some(event => event.kind === 'release_launch_intent'));
  }
});

test('a complete string-count history recovers an unknown ACK by exact identity without another launch', async () => {
  const f = fixture({ alteration: release => Object.assign(release, { status: 'unknown', attempts: 1, knownBuilds: [] }) });
  f.platform.call = async path => {
    if (path.includes('/build/logs')) return { total: '1', data: [{ sn: 'real-accepted-build', sha,
      event: 'api_trigger_desktop_release', title: `WorkLoom release ${f.key}` }] };
    if (path.includes('/build/status/')) return { status: 'pending' };
    throw new Error(`Unknown ACK recovery must not call ${path}`);
  };
  assert.equal((await reconcileReleases({ ...f, now: 2 }))[0].status, 'running');
  assert.equal(f.starts(), 0);
  assert.equal(f.current().releases[f.key].build.sn, 'real-accepted-build');
});

test('only the recorded never-dispatched history ABI park can resume after a strict readback', async () => {
  const f = fixture({ parked: true });
  assert.equal((await reconcileReleases({ ...f, now: 2 }))[0].status, 'running');
  assert.equal(f.starts(), 1);
  assert.ok(f.current().events.some(event => event.kind === 'release_prelaunch_history_recovered'));
  await reconcileReleases({ ...f, now: 3 });
  assert.equal(f.starts(), 1);
});

test('prior attempts, launch intents, ACKs, different parks and unsafe history cannot auto-resume', async () => {
  const alterations = [release => { release.attempts = 1; }, release => { release.launchIntentAt = 2; },
    release => { release.launchedAt = 2; }, release => { release.build = { sn: 'prior-ack' }; },
    release => { release.builds = ['prior-build']; }, release => { release.tag.sha = 'b'.repeat(40); },
    release => { release.error = 'Operator stop'; },
    (release, state) => appendEvent(state, 'release_launch_intent', { key: release.key, attempt: 1 }, 2)];
  for (const alteration of alterations) {
    const f = fixture({ parked: true, alteration });
    await reconcileReleases({ ...f, now: 3 }); assert.equal(f.starts(), 0);
    assert.equal(f.current().releases[f.key].status, 'parked');
    assert.ok(!f.current().events.some(event => event.kind === 'release_prelaunch_history_recovered'));
  }
  const malformed = fixture({ parked: true, history: { total: '1', data: [] } });
  assert.equal((await reconcileReleases({ ...malformed, now: 3 }))[0].status, 'parked');
  assert.equal(malformed.starts(), 0);
  const prior = fixture({ parked: true });
  prior.platform.call = async path => {
    if (path.includes('/build/logs')) return { total: '1', data: [{ sn: 'prior-out-of-ledger', sha,
      event: 'api_trigger_desktop_release', title: `WorkLoom release ${prior.key}` }] };
    throw new Error(`No tag or launch expected: ${path}`);
  };
  assert.equal((await reconcileReleases({ ...prior, now: 3 }))[0].status, 'parked');
  assert.equal(prior.starts(), 0);
});

test('a concurrent recovered ACK remains running and is never overwritten by the stale prelaunch recovery', async () => {
  const f = fixture({ parked: true });
  const originalCall = f.platform.call;
  f.platform.call = async (path, options) => {
    if (path.includes('/build/logs')) {
      await f.store.mutate(state => {
        Object.assign(state.releases[f.key], { status: 'running', attempts: 1, build: { sn: 'concurrent-ack' } });
        appendEvent(state, 'release_started', { key: f.key, sn: 'concurrent-ack' }, 2);
      });
    }
    return originalCall(path, options);
  };
  assert.equal((await reconcileReleases({ ...f, now: 3 }))[0].status, 'recovery_conflict');
  assert.equal(f.starts(), 0);
  assert.equal(f.current().releases[f.key].status, 'running');
  assert.equal(f.current().releases[f.key].build.sn, 'concurrent-ack');
});
