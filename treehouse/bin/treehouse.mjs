#!/usr/bin/env node

import { runTreehouseCli } from "../runtime/cli.mjs";

try {
  process.exitCode = await runTreehouseCli(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
