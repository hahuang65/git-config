import { runGit } from "./git.mjs";

export async function readWorktreeMetadata(cwd) {
  const { stdout } = await runGit(cwd, ["worktree", "list", "--porcelain", "-z"]);
  return parseWorktreeMetadata(stdout);
}

function parseWorktreeMetadata(output) {
  const records = [];
  let fields = {};
  for (const field of output.split("\0")) {
    if (field) {
      fields = { ...fields, ...parseField(field) };
      continue;
    }
    if (!fields.worktree) continue;
    records.push({
      path: fields.worktree,
      head: fields.HEAD,
      branch: fields.branch?.replace("refs/heads/", ""),
      prunable: Object.hasOwn(fields, "prunable"),
    });
    fields = {};
  }
  return records;
}

function parseField(field) {
  const separator = field.indexOf(" ");
  if (separator < 0) return { [field]: true };
  return { [field.slice(0, separator)]: field.slice(separator + 1) };
}
