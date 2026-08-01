import { realpath } from "node:fs/promises";
import path from "node:path";

export async function canonicalPath(candidate) {
  return realpath(candidate).catch(() => path.resolve(candidate));
}

export async function pathsReferToSameLocation(left, right) {
  return await canonicalPath(left) === await canonicalPath(right);
}
