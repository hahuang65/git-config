import { randomUUID } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const POLL_INTERVAL_MS = 25;

export function createManagedReturnChannel() {
  const token = randomUUID();
  return {
    token,
    requestPath: path.join(tmpdir(), `treehouse-return-${token}.json`),
  };
}

export async function writeManagedReturnRequest(transition) {
  const token = process.env.TREEHOUSE_RETURN_TOKEN;
  const requestPath = process.env.TREEHOUSE_RETURN_REQUEST;
  if (!token || !requestPath) return false;
  validateReturnPath(requestPath, token);
  await writeFile(requestPath, JSON.stringify({
    token,
    operationId: transition.operationId,
    requesterPid: process.pid,
  }), { flag: "wx", mode: 0o600 });
  return true;
}

export async function monitorManagedReturn(child, channel, isClosed) {
  while (!isClosed()) {
    const request = await readReturnRequest(channel);
    if (request) {
      await waitForProcessExit(request.requesterPid);
      if (!isClosed()) child.kill("SIGHUP");
      return request;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return readReturnRequest(channel);
}

export async function clearManagedReturn(channel) {
  await unlink(channel.requestPath).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
}

async function readReturnRequest(channel) {
  try {
    const request = JSON.parse(await readFile(channel.requestPath, "utf8"));
    if (request.token !== channel.token || typeof request.operationId !== "string") return undefined;
    return request;
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function validateReturnPath(requestPath, token) {
  const expected = path.join(tmpdir(), `treehouse-return-${token}.json`);
  if (requestPath !== expected || !/^[0-9a-f-]{36}$/.test(token)) {
    throw new Error("Invalid managed-shell return channel");
  }
}

async function waitForProcessExit(pid) {
  while (isProcessAlive(pid)) await sleep(POLL_INTERVAL_MS);
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
