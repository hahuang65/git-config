import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const COMPLETION_VERSION = 1;
const OPERATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export async function readCompletedRebase(registry, operationId) {
  const completionPath = resolveCompletionPath(registry, operationId);
  try {
    const completion = JSON.parse(await readFile(completionPath, "utf8"));
    if (completion?.version !== COMPLETION_VERSION || completion.operationId !== operationId) {
      throw new Error(`Completed Orchard rebase '${operationId}' has invalid durable state`);
    }
    return completion.outcome;
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

export async function recordCompletedRebase(registry, operationId, outcome) {
  const completionPath = resolveCompletionPath(registry, operationId);
  await mkdir(path.dirname(completionPath), { recursive: true });
  const temporaryPath = `${completionPath}.tmp-${randomUUID()}`;
  const completion = { version: COMPLETION_VERSION, operationId, outcome };
  await writeFile(temporaryPath, `${JSON.stringify(completion, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await rename(temporaryPath, completionPath);
}

function resolveCompletionPath(registry, operationId) {
  if (!OPERATION_ID_PATTERN.test(operationId)) throw new Error("Invalid Orchard rebase operation ID");
  return path.join(registry.directory, "completed-rebases", `${operationId}.json`);
}
