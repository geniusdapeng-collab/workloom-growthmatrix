import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assembleRelease, sealPlatform } from '../desktop-release-finalizer.mjs';
import { emptyState, validateState, releaseKey } from './queue-model.mjs';
import { ensureDesktopReleaseTag, enqueueReleases, reconcileReleases, verifyRelease } from './queue-release.mjs';

const repo = 'workloom-ai/workloom-growthmatrix';
const sha = 'a'.repeat(40), otherSha = 'b'.repeat(40), version = 'v0.1.1';
const release = { sha, kind: 'desktop', version, build: { sn: 'native-build' } };
const key = releaseKey({ repo, sha, kind: release.kind, version });
const build = { sn: release.build.sn, sha, event: 'api_trigger_desktop_release', title: `WorkLoom release ${key}` };
const absent = () => Object.assign(new Error('Tag not found'), { status: 404 });
const fixtureCredential = randomUUID();

function memoryStore(initial) {
  let value = structuredClone(initial);
  return {
    read: async () => structuredClone(value),
    mutate: async operation => {
      const next = structuredClone(value), result = operation(next);
      validateState(next, repo); value = next;
      return { state: structuredClone(value), result };
    },
  };
}
function pendingStore() {
  const state = emptyState(repo);
  enqueueReleases(state, repo, { number: 1, merge: { sha }, intent: { releases: [{ kind: 'desktop', version }] } }, 1);
  return memoryStore(state);
}
function metadataPlatform() {
  return { repo, token: fixtureCredential, call: async path => {
    if (path.includes('/build/logs')) return { total: 1, data: [build] };
    if (path.includes('/releases/tags/')) return { id: 'native-release', draft: false };
    if (path.includes('/git/commits/')) return { sha };
    throw new Error(`Unexpected API path ${path}`);
  } };
}
async function nativeManifest(t) {
  const root = await mkdtemp(join(tmpdir(), 'workloom-queue-release-contract-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const identity = { repository: repo, tag: version, sha, platformSigning: 'signed' };
  const directories = {};
  for (const platform of ['macos', 'windows']) {
    const raw = join(root, `${platform}-raw`), sealed = join(root, platform);
    await mkdir(raw);
    const names = platform === 'macos'
      ? [`workloom-growthmatrix-${version}-mac-arm64.dmg`, `workloom-growthmatrix-${version}-mac-x64.dmg`]
      : [`workloom-growthmatrix-${version}-win-x64.exe`];
    for (const name of names) await writeFile(join(raw, name), Buffer.from(`Actual local contract fixture: ${name}`));
    sealPlatform({ ...identity, platform, releaseDir: raw, outputDir: sealed });
    directories[platform] = sealed;
  }
  const output = join(root, 'release');
  const manifest = assembleRelease({ ...identity, macDir: directories.macos, windowsDir: directories.windows, outputDir: output });
  const calls = [];
  const download = async (actualRepo, tag, name, options) => {
    assert.equal(actualRepo, repo); assert.equal(tag, version); assert.equal(options.token, fixtureCredential);
    calls.push(name);
    const bytes = await readFile(join(output, name));
    return { name, size: bytes.length, sha512: createHash('sha512').update(bytes).digest('hex'),
      ...(options.json ? { data: JSON.parse(bytes.toString('utf8')) } : {}) };
  };
  return { manifest, calls, download };
}

test('queue verifies the real native finalizer schema and product/version installer names from actual local bytes', async t => {
  const { manifest, download, calls } = await nativeManifest(t);
  assert.equal(manifest.sourceSha, undefined); assert.equal(manifest.sha, sha);
  const receipt = await verifyRelease(metadataPlatform(), release, download);
  assert.equal(receipt.assets.length, 3);
  assert.deepEqual(receipt.assets.map(asset => asset.name), manifest.assets.map(asset => asset.name));
  assert.equal(calls.length, 4);
  assert.equal(receipt.sha, sha); assert.equal(receipt.build, release.build.sn);
});

test('wrong source, product, tag, unsigned mode, unsafe names and duplicate platforms cannot become a delivery receipt', async t => {
  const { manifest } = await nativeManifest(t);
  const mutations = [
    value => { value.sha = otherSha; }, value => { value.product = 'workloom-ai/foreign'; },
    value => { value.tag = 'v0.1.2'; }, value => { value.platformSigning = 'unsigned'; },
    value => { value.assets[0].name = '../unsafe-mac-arm64.dmg'; },
    value => { value.assets[1].name = value.assets[0].name; },
    value => { value.assets[1].name = 'second-mac-arm64.dmg'; },
    value => { value.assets[2].size = 0; }, value => { value.assets[2].sha512 = 'invalid'; },
  ];
  for (const mutate of mutations) {
    const value = structuredClone(manifest); mutate(value); let binaries = 0;
    const download = async (_repo, _tag, name) => {
      if (name.endsWith('.json')) return { data: value };
      binaries++; const row = value.assets.find(asset => asset.name === name);
      return { name, size: row.size, sha512: row.sha512 };
    };
    await assert.rejects(verifyRelease(metadataPlatform(), release, download), /manifest|Desktop/);
    assert.ok(binaries < 3);
  }
  for (const value of [null, [], {}, 'not a manifest']) {
    await assert.rejects(verifyRelease(metadataPlatform(), release, async () => ({ data: value })), /manifest/);
  }
});

test('native-looking names do not substitute for actual installer sizes and byte digests', async t => {
  const { download } = await nativeManifest(t);
  for (const change of ['size', 'sha512']) {
    await assert.rejects(verifyRelease(metadataPlatform(), release, async (...args) => {
      const result = await download(...args);
      if (!args[2].endsWith('.json')) result[change] = change === 'size' ? result.size + 1 : 'c'.repeat(128);
      return result;
    }), /byte receipt mismatch/);
  }
});

test('existing exact stable tag is reused without a write and a moved tag is never replaced', async () => {
  for (const tag of [{ name: version, commit: { sha } }, { name: `refs/tags/${version}`, target_type: 'commit', target: sha }]) {
    let writes = 0;
    const platform = { call: async (_path, options) => { if (options?.method) writes++; return tag; } };
    assert.deepEqual(await ensureDesktopReleaseTag(platform, { sha, version, key }), { name: version, sha });
    assert.equal(writes, 0);
  }
  let writes = 0;
  await assert.rejects(ensureDesktopReleaseTag({ call: async (_path, options) => {
    if (options?.method) writes++; return { name: version, commit: { sha: otherSha } };
  } }, { sha, version, key }), /refusing replacement/);
  assert.equal(writes, 0);
});

test('missing tag is created once through the official target field, then verified before a signed build launch', async () => {
  const store = pendingStore(); let tag = null, creates = 0, starts = 0;
  const platform = { repo, error: error => error.message, call: async (path, options) => {
    if (path === `/-/git/tags/${version}`) { if (!tag) throw absent(); return tag; }
    if (path === '/-/git/tags') {
      assert.equal(options.method, 'POST'); assert.equal(options.body.name, version); assert.equal(options.body.target, sha);
      assert.ok((await store.read()).events.some(event => event.kind === 'release_tag_intent'));
      creates++; tag = { name: version, commit: { sha } }; return tag;
    }
    if (path.includes('/build/logs')) return { total: 0, data: [] };
    if (path === '/-/build/start') {
      starts++; assert.deepEqual(options.body.env, { DELIVERY_RELEASE_ID: key, RELEASE_EXPECTED_SHA: sha,
        RELEASE_TAG: version, RELEASE_SHA: sha, PLATFORM_SIGNING: 'signed' });
      assert.equal(options.body.sha, sha); assert.equal(options.body.branch, 'main');
      assert.equal(options.body.event, 'api_trigger_desktop_release');
      return { success: true, sn: 'native-start' };
    }
    if (path.includes('/build/status/')) return { status: 'pending' };
    throw new Error(`Unexpected ${path}`);
  } };
  assert.equal((await reconcileReleases({ platform, store, now: 2 }))[0].status, 'running');
  await reconcileReleases({ platform, store, now: 3 });
  assert.equal(creates, 1); assert.equal(starts, 1);
  assert.deepEqual((await store.read()).releases[key].tag, { name: version, sha });
});

test('lost tag-create acknowledgement is recovered by readback; unreadable or mismatched state cannot launch', async () => {
  for (const outcome of ['accepted', 'absent', 'mismatch', 'read-denied']) {
    const store = pendingStore(); let reads = 0, creates = 0, starts = 0;
    const platform = { repo, error: error => error.message, call: async (path, options) => {
      if (path === `/-/git/tags/${version}`) {
        reads++; if (reads === 1 || outcome === 'absent') throw absent();
        if (outcome === 'read-denied') throw Object.assign(new Error('Read denied'), { status: 403 });
        return { name: version, commit: { sha: outcome === 'mismatch' ? otherSha : sha } };
      }
      if (path === '/-/git/tags') { creates++; throw new Error('Lost create acknowledgement'); }
      if (path.includes('/build/logs')) return { total: 0, data: [] };
      if (path === '/-/build/start') { starts++; return { success: true, sn: 'native-start' }; }
      throw new Error(`Unexpected ${path} ${options?.method ?? 'GET'}`);
    } };
    const result = (await reconcileReleases({ platform, store, now: 2 }))[0];
    assert.equal(result.status, outcome === 'accepted' ? 'running' : 'parked');
    assert.equal(creates, 1); assert.equal(starts, outcome === 'accepted' ? 1 : 0);
  }
});

test('tag read permission failures and invalid stable identities cause no tag write or deployment', async () => {
  for (const status of [401, 403, 429, 500]) {
    let writes = 0;
    await assert.rejects(ensureDesktopReleaseTag({ call: async (_path, options) => {
      if (options?.method) writes++; throw Object.assign(new Error('Read failed'), { status });
    } }, { sha, version, key }), /Read failed/);
    assert.equal(writes, 0);
  }
  let calls = 0;
  const platform = { call: async () => { calls++; throw new Error('Unexpected network'); } };
  for (const value of [{ sha, version: 'v0.1.1-beta' }, { sha: 'invalid', version }, { sha, version: '../v0.1.1' }]) {
    await assert.rejects(ensureDesktopReleaseTag(platform, { ...value, key }), /stable version/);
  }
  assert.equal(calls, 0);
});
