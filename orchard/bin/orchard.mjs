#!/usr/bin/env node

import { runOrchardCli } from "../runtime/cli.mjs";

try {
  process.exitCode = await runOrchardCli(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
