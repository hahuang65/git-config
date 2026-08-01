import { randomUUID } from "node:crypto";
import { mkdir, rmdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 10_000;
const RETRY_DELAY_MS = 25;

export async function withProjectLock(directory, action, options = {}) {
  const lock = await acquireLock(directory, options);
  try {
    return await action();
  } finally {
    await releaseLock(lock);
  }
}

async function acquireLock(directory, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const lockPath = path.join(directory, ".lock");
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      await mkdir(lockPath);
      const ownerPath = path.join(lockPath, "owner.json");
      await writeFile(ownerPath, JSON.stringify({ pid: process.pid, token: randomUUID() }), { mode: 0o600 });
      return { lockPath, ownerPath };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for Orchard lock at ${lockPath}`);
      await sleep(RETRY_DELAY_MS);
    }
  }
}

async function releaseLock({ lockPath, ownerPath }) {
  await unlink(ownerPath);
  await rmdir(lockPath);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
