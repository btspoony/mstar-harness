/**
 * Test-only preload: deny and RECORD every outbound provider channel a CLI child
 * could open. It is loaded with `NODE_OPTIONS=--require` into the built CLI, so a
 * regression that reaches the network, a provider credential outside the sandbox,
 * or a subprocess other than the pinned Git executable fails the child instead of silently
 * passing the suite.
 *
 * Zero violations means the guard loaded and observed none: the "loaded" record is
 * written first, so a suite can never mistake an unloaded guard for a clean run.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");
const net = require("node:net");
const http = require("node:http");
const https = require("node:https");
const tls = require("node:tls");

const logPath = process.env.MSTAR_NO_PROVIDER_LOG;
if (!logPath) throw new Error("remote-no-provider guard: MSTAR_NO_PROVIDER_LOG is required");
const sentinel = process.env.MSTAR_NO_PROVIDER_SENTINEL ?? "";
const append = fs.appendFileSync;

append(logPath, `${JSON.stringify({ kind: "loaded" })}\n`);

function record(kind, detail) {
  append(logPath, `${JSON.stringify({ kind, detail: String(detail) })}\n`);
  throw new Error(`remote-no-provider guard: refused ${kind}: ${String(detail)}`);
}

function denied(kind) {
  return function refuse(...args) {
    const detail = args
      .slice(0, 2)
      .filter((value) => value !== undefined && value !== null)
      .map((value) => (typeof value === "object" ? JSON.stringify(value) : String(value)))
      .join(" ");
    return record(kind, detail);
  };
}

net.connect = denied("network:net");
net.createConnection = denied("network:net");
net.Socket.prototype.connect = denied("network:net");
const dgram = require("node:dgram");
dgram.createSocket = denied("network:dgram");
http.request = denied("network:http");
http.get = denied("network:http");
https.request = denied("network:https");
https.get = denied("network:https");
tls.connect = denied("network:tls");
require("node:http2").connect = denied("network:http2");

Object.defineProperty(globalThis, "fetch", {
  configurable: true,
  writable: true,
  value: denied("network:fetch"),
});
Object.defineProperty(globalThis, "WebSocket", {
  configurable: true,
  writable: true,
  value: class GuardedWebSocket {
    constructor(url) {
      record("network:websocket", url);
    }
  },
});

function guardRead(name, holder) {
  const original = holder[name];
  holder[name] = function guardedRead(file, ...rest) {
    if (sentinel !== "" && path.resolve(String(file)) === path.resolve(sentinel)) {
      record("fs:credential-read", file);
    }
    return original.call(holder, file, ...rest);
  };
}

guardRead("readFileSync", fs);
guardRead("readFile", fs);
guardRead("openSync", fs);
guardRead("open", fs);
guardRead("createReadStream", fs);
guardRead("readFile", fs.promises);
guardRead("open", fs.promises);

const allowedGit = process.env.MSTAR_NO_PROVIDER_GIT ?? "";

/**
 * note: Resolve the executable from the options the child actually spawns with, so a caller
 * cannot pin this process's PATH and then run a foreign binary from its own environment. An
 * empty PATH entry means the child's cwd, exactly as the platform's lookup treats it.
 */
function executablePath(command, options) {
  const value = String(command);
  const cwd = options.cwd ?? process.cwd();
  const searchPath = String((options.env ?? process.env).PATH ?? "");
  const candidates = value.includes(path.sep)
    ? [path.resolve(cwd, value)]
    : searchPath.split(path.delimiter).map((dir) => path.resolve(cwd, dir, value));
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync(candidate);
    } catch {
      // note: A missing or non-executable candidate is not the pinned Git.
    }
  }
  return null;
}

function isGit(command, options) {
  if (allowedGit === "") return false;
  const resolved = executablePath(command, options);
  if (resolved === null) return false;
  try {
    return resolved === fs.realpathSync(allowedGit);
  } catch {
    return false;
  }
}

/** note: The trailing options object of `(file[, args][, options])`; an args array is not one. */
function spawnOptions(rest) {
  const last = rest[rest.length - 1];
  return last !== null && typeof last === "object" && !Array.isArray(last) ? last : {};
}

function guardSpawn(name) {
  const original = childProcess[name];
  childProcess[name] = function guardedSpawn(command, ...rest) {
    const options = spawnOptions(rest);
    // note: A shell interprets the command itself, so pinning the Git path would mean nothing.
    if (options.shell) record("spawn:shell", command);
    if (!isGit(command, options)) record("spawn", command);
    return original.call(childProcess, command, ...rest);
  };
}

guardSpawn("spawn");
guardSpawn("spawnSync");
guardSpawn("execFile");
guardSpawn("execFileSync");
["exec", "execSync", "fork"].forEach((name) => {
  childProcess[name] = denied("spawn:shell");
});

// note: A Node ESM child reads builtin named exports from a facade that snapshots this
// module's exports; re-sync after the patches so `import { readFileSync }` cannot bypass them.
require("node:module").syncBuiltinESMExports();
