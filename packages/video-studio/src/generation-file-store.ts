/** Private, durable generation journals. A stale lock is recoverable only with a known acceptance. */
import { constants, closeSync, existsSync, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";

export class GenerationFileStore {
  readonly root: string;
  private readonly realRoot: string;
  constructor(root: string) {
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    if (lstatSync(this.root).isSymbolicLink() || !lstatSync(this.root).isDirectory()) throw new Error("GENERATION_JOURNAL_PATH_INVALID");
    this.realRoot = realpathSync(this.root);
  }
  private checkRoot(): void {
    if (lstatSync(this.root).isSymbolicLink() || realpathSync(this.root) !== this.realRoot) throw new Error("GENERATION_JOURNAL_ROOT_CHANGED");
  }
  path(key: string): string {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("GENERATION_JOURNAL_KEY_INVALID");
    this.checkRoot(); return join(this.root, `${key}.json`);
  }
  private read(path: string): string | null {
    this.checkRoot();
    let fd: number;
    try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.size > 128 * 1024 * 1024) throw new Error("GENERATION_JOURNAL_FILE_INVALID");
      return readFileSync(fd, "utf8");
    } finally { closeSync(fd); }
  }
  load(key: string): unknown | null {
    const text = this.read(this.path(key));
    if (text === null) return null;
    try { return JSON.parse(text); }
    catch { throw new Error("GENERATION_JOURNAL_CORRUPT: do not submit again"); }
  }
  save(key: string, value: unknown): void {
    const target = this.path(key), temporary = join(this.root, `.${key}-${randomUUID()}.tmp`);
    if (existsSync(target) && lstatSync(target).isSymbolicLink()) throw new Error("GENERATION_JOURNAL_FILE_INVALID");
    let fd: number | undefined;
    try {
      fd = openSync(temporary, "wx", 0o600);
      writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); fsyncSync(fd); closeSync(fd); fd = undefined;
      this.checkRoot();
      if (existsSync(target) && lstatSync(target).isSymbolicLink()) throw new Error("GENERATION_JOURNAL_FILE_INVALID");
      renameSync(temporary, target);
      const directory = openSync(dirname(target), constants.O_RDONLY);
      try { fsyncSync(directory); } finally { closeSync(directory); }
    } finally {
      if (fd !== undefined) closeSync(fd);
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
  private owner(text: string): { pid: number; token: string } {
    let value: { pid: number; token: string };
    try { value = JSON.parse(text) as typeof value; }
    catch { throw new Error("GENERATION_LOCK_INVALID: unknown owner, do not submit again"); }
    if (!value || !Number.isInteger(value.pid) || value.pid <= 0 || typeof value.token !== "string" || !value.token) throw new Error("GENERATION_LOCK_INVALID");
    return value;
  }
  private dead(pid: number): boolean {
    try { process.kill(pid, 0); return false; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
      if ((error as NodeJS.ErrnoException).code === "EPERM") return false;
      throw error;
    }
  }
  /** Never remove a live/unknown owner's lock, including after timeout. */
  async locked<T>(key: string, input: { timeoutMs: number; canRecover: () => boolean }, fn: () => Promise<T>): Promise<T> {
    if (!Number.isFinite(input.timeoutMs) || input.timeoutMs < 0) throw new Error("GENERATION_LOCK_TIMEOUT_INVALID");
    const lockPath = `${this.path(key)}.lock`, fencePath = `${lockPath}.recover`;
    const owner = JSON.stringify({ pid: process.pid, token: randomUUID() }), deadline = Date.now() + input.timeoutMs;
    let held = false;
    const createLock = (path: string): void => {
      this.checkRoot(); const fd = openSync(path, "wx", 0o600);
      try { writeFileSync(fd, owner); fsyncSync(fd); } finally { closeSync(fd); }
    };
    for (;;) {
      if (this.read(fencePath) !== null) {
        if (Date.now() >= deadline) throw new Error("GENERATION_RECOVERY_BUSY: existing recovery fence requires reconciliation");
        await new Promise(resolveWait => setTimeout(resolveWait, 20)); continue;
      }
      try {
        createLock(lockPath);
        // A recovery fence may have appeared between the read and O_EXCL.
        if (this.read(fencePath) === null) { held = true; break; }
        if (this.read(lockPath) !== owner) throw new Error("GENERATION_LOCK_CHANGED");
        unlinkSync(lockPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const previous = this.read(lockPath);
        if (previous === null) continue;
        const holder = this.owner(previous);
        if (this.dead(holder.pid)) {
          if (!input.canRecover()) throw new Error("GENERATION_LOCK_STALE_UNKNOWN: acceptance unknown, do not submit again");
          try { createLock(fencePath); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") continue; throw error; }
          try {
            if (this.read(lockPath) === previous && this.dead(holder.pid) && input.canRecover()) unlinkSync(lockPath);
          } finally {
            if (this.read(fencePath) !== owner) throw new Error("GENERATION_RECOVERY_OWNER_CHANGED");
            unlinkSync(fencePath);
          }
          continue;
        }
      }
      if (Date.now() >= deadline) throw new Error("GENERATION_LOCKED: timed out without submitting again");
      await new Promise(resolveWait => setTimeout(resolveWait, 20));
    }
    let primary: unknown;
    try { return await fn(); }
    catch (error) { primary = error; throw error; }
    finally {
      if (held) {
        try {
          if (this.read(lockPath) !== owner) throw new Error("GENERATION_LOCK_CHANGED: do not remove another owner");
          unlinkSync(lockPath);
        } catch (error) {
          if (primary) throw new AggregateError([primary, error], "Generation operation and journal lock release failed");
          throw error;
        }
      }
    }
  }
}
