#!/usr/bin/env node
import { homedir } from "node:os";
import { execute } from "./cli.js";

const controller = new AbortController();
// once：第一次信号走优雅退出，再按一次交还给默认行为，直接终止。
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => controller.abort());
}

process.exitCode = await execute(process.argv.slice(2), {
  env: process.env,
  home: homedir(),
  cwd: process.cwd(),
  stdout: process.stdout,
  stderr: process.stderr,
  signal: controller.signal,
});
