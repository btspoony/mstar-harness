#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = path.join(pluginRoot, "dist/mcp/stdio.js");
const server = spawn(process.execPath, [serverPath], { cwd: pluginRoot, stdio: "inherit" });
server.once("error", (error) => {
  console.error(`kimi mcp launcher: ${error.message}`);
  process.exitCode = 1;
});
server.once("exit", (code) => {
  process.exitCode = code ?? 1;
});
