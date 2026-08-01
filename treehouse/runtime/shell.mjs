import { spawn } from "node:child_process";

import {
  clearManagedReturn,
  createManagedReturnChannel,
  monitorManagedReturn,
} from "./managed-return.mjs";

export async function openManagedShell(cwd, { shell = process.env.SHELL, environment = process.env } = {}) {
  if (!shell) throw new Error("SHELL is required for interactive Treehouse entry");
  const channel = createManagedReturnChannel();
  let closed = false;
  const child = spawn(shell, [], {
    cwd,
    env: {
      ...environment,
      TREEHOUSE_RETURN_REQUEST: channel.requestPath,
      TREEHOUSE_RETURN_TOKEN: channel.token,
    },
    stdio: "inherit",
  });
  const monitor = monitorManagedReturn(child, channel, () => closed);
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  closed = true;
  const returnRequest = await monitor;
  await clearManagedReturn(channel);
  if (exitCode !== 0 && !returnRequest) throw new Error(`Managed shell exited with status ${exitCode}`);
  return { returnRequest };
}
