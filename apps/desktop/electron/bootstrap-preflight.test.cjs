"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { bootstrap } = require("./bootstrap.cjs");

function put(root, ref, contents) {
  const file = path.join(root, ref);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function fixture(t, manifestText, probeError) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloom-precommit 中文-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const resourcesDir = path.join(root, "resources"), supportDir = path.join(root, "support");
  put(resourcesDir, "runtime/VERSION", "fixture-new\n");
  put(resourcesDir, "runtime/.env.defaults", "LLM_PROVIDER=mock\n");
  put(resourcesDir, "runtime/product.manifest.json", manifestText);
  put(resourcesDir, "runtime/scripts/desktop-bootstrap-db.mjs", "// Only syntax checked; no database is used by this fixture.\n");
  put(resourcesDir, "runtime/scripts/product-runtime.mjs", fs.readFileSync(path.join(__dirname, "../../../scripts/product-runtime.mjs")));
  // A tiny controlled loader isolates the precommit execution contract. Actual
  // package imports and production tsx are exercised by the physical payload probe.
  put(resourcesDir, "runtime/node_modules/tsx/dist/cli.mjs", "import {pathToFileURL} from 'node:url'; await import(pathToFileURL(process.argv[2]).href);\n");
  put(resourcesDir, "runtime/scripts/runtime-payload-probe.mts", `import {loadProductRuntime} from './product-runtime.mjs'; const product=loadProductRuntime(); ${probeError ? "throw new Error('controlled-import-closure-failure');" : "console.log('RUNTIME_PREFLIGHT '+JSON.stringify({status:'passed',productId:product.productId,checks:['fixture-only']}));"}\n`);
  put(resourcesDir, "runtime/node_modules/vite/bin/vite.js", "// No service starts in this failure fixture.\n");
  for (const file of ["postgres", "pg_ctl", "initdb"]) put(resourcesDir, `pg/bin/${file}${process.platform === "win32" ? ".exe" : ""}`, "owned unused placeholder\n");
  const nodeRef = process.platform === "win32" ? "node/node.exe" : "node/bin/node";
  fs.mkdirSync(path.dirname(path.join(resourcesDir, nodeRef)), { recursive: true });
  fs.copyFileSync(process.execPath, path.join(resourcesDir, nodeRef), fs.constants.COPYFILE_FICLONE);
  put(supportDir, "runtime/.env", "LLM_MODEL=preserve-this-customer-choice\nJWT_SECRET=fixture-existing-secret-must-stay-private\n");
  put(supportDir, "runtime/customer-marker.txt", "old-runtime-marker\n");
  put(supportDir, "VERSION", "fixture-old\n");
  put(supportDir, ".bootstrapped", "existing-example-state\n");
  put(supportDir, "pgdata/customer-marker.txt", "untouched-customer-database\n");
  const snapshot = (ref) => fs.readFileSync(path.join(supportDir, ref), "utf8");
  const retained = ["runtime/.env", "runtime/customer-marker.txt", "VERSION", ".bootstrapped", "pgdata/customer-marker.txt"];
  return { resourcesDir, supportDir, retained, before: retained.map(snapshot), snapshot };
}

test("无效完整产品清单在载荷提交与数据库状态创建前拒绝，并恢复旧实例", async t => {
  const f = fixture(t, "{broken-product-manifest", false);
  await assert.rejects(bootstrap({ resourcesDir: f.resourcesDir, supportDir: f.supportDir, smoke: true }), /清单|预检|无法解析/u);
  assert.equal(fs.existsSync(path.join(f.supportDir, "database-state.json")), false);
  assert.deepEqual(f.retained.map(f.snapshot), f.before);
  assert.equal(fs.existsSync(path.join(f.supportDir, ".bootstrap-lock")), false);
  const checkpoint = JSON.parse(fs.readFileSync(path.join(f.supportDir, "install-state.json")));
  assert.equal(checkpoint.rolledBack, true);
});

test("实际隔离子进程的导入失败在数据库副作用前拒绝，保留旧配置与数据", async t => {
  const manifest = fs.readFileSync(path.join(__dirname, "../../../product.manifest.json"), "utf8");
  const f = fixture(t, manifest, true);
  await assert.rejects(bootstrap({ resourcesDir: f.resourcesDir, supportDir: f.supportDir, smoke: true }), /载荷预检/u);
  assert.equal(fs.existsSync(path.join(f.supportDir, "database-state.json")), false);
  assert.deepEqual(f.retained.map(f.snapshot), f.before);
  assert.equal(fs.existsSync(path.join(f.supportDir, ".bootstrap-lock")), false);
  const checkpoint = JSON.parse(fs.readFileSync(path.join(f.supportDir, "install-state.json")));
  assert.equal(checkpoint.rolledBack, true);
});
