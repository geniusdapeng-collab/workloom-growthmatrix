import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { GenerationFileStore } from "./generation-file-store.js";

const execute = promisify(execFile);
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const root = () => { const value = mkdtempSync(join(tmpdir(), "generation-lock-race-")); roots.push(value); return value; };

it("独立进程在owner写到一半时竞争，看到的锁始终完整且只执行一次提交", async () => {
  const folder = root(), ready = join(folder, "ready"), resume = join(folder, "resume"), count = join(folder, "paid-count");
  const module = fileURLToPath(new URL("./generation-file-store.ts", import.meta.url)), key = "a".repeat(64);
  const operation = `
    const { GenerationFileStore } = await import(${JSON.stringify(module)});
    const store = new GenerationFileStore(${JSON.stringify(folder)});
    await store.locked(${JSON.stringify(key)}, {timeoutMs: 10000, canRecover: () => store.load(${JSON.stringify(key)}) !== null}, async () => {
      if (store.load(${JSON.stringify(key)}) === null) {
        fs.appendFileSync(${JSON.stringify(count)}, '1');
        store.save(${JSON.stringify(key)}, {state:'accepted'});
      }
    });
    console.log('complete');
  `;
  const paused = `
    import fs from 'node:fs';
    import {syncBuiltinESMExports} from 'node:module';
    const originalWrite = fs.writeFileSync;
    let firstOwner = true;
    fs.writeFileSync = function(fd, body, ...rest) {
      if (firstOwner && typeof fd === 'number' && typeof body === 'string' && body.startsWith('{"pid":')) {
        firstOwner = false;
        originalWrite(fd, '{"pid":');
        originalWrite(${JSON.stringify(ready)}, 'ready');
        const deadline = Date.now() + 20000;
        while (!fs.existsSync(${JSON.stringify(resume)})) {
          if (Date.now() >= deadline) throw new Error('fixture owner release timed out');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
        return originalWrite(fd, body.slice(7), ...rest);
      }
      return originalWrite(fd, body, ...rest);
    };
    syncBuiltinESMExports();
    ${operation}
  `;
  const first = execute(process.execPath, ["--import", "tsx", "--input-type=module", "-e", paused], { timeout: 30000 });
  // Attach a rejection handler immediately while the process is intentionally paused.
  const firstResult = first.then(value => ({ value }), error => ({ error }));
  let competingError: unknown;
  try {
    const deadline = Date.now() + 15000;
    while (!existsSync(ready)) {
      if (Date.now() >= deadline) throw new Error("fixture owner never reached partial write");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const second = await execute(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `import fs from 'node:fs'; ${operation}`], { timeout: 15000 });
    expect(second.stdout.trim()).toBe("complete");
  } catch (error) { competingError = error; }
  finally { writeFileSync(resume, "resume"); }
  const finished = await firstResult;
  if (competingError) throw competingError;
  if ("error" in finished) throw finished.error;
  expect(finished.value.stdout.trim()).toBe("complete");
  expect(readFileSync(count, "utf8")).toBe("1");
  expect(readdirSync(folder).filter(name => name.endsWith(".lock") || name.endsWith(".tmp"))).toHaveLength(0);
}, 45000);

it("真实损坏/未知owner仍拒绝执行，不删除原锁来重试", async () => {
  const folder = root(), store = new GenerationFileStore(folder), key = "b".repeat(64), lock = `${store.path(key)}.lock`;
  for (const body of ["", '{"pid":', JSON.stringify({pid: process.pid}), JSON.stringify({pid: 0, token: "bad"})]) {
    writeFileSync(lock, body);
    let executed = false;
    await expect(store.locked(key, {timeoutMs: 0, canRecover: () => true}, async () => { executed = true; })).rejects.toThrow("LOCK_INVALID");
    expect(executed).toBe(false); expect(readFileSync(lock, "utf8")).toBe(body);
    expect(readdirSync(folder).filter(name => name.endsWith(".tmp"))).toHaveLength(0);
  }
});
