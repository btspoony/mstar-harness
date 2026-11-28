"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { fileURLToPath } = require("node:url");
const childProcess = require("node:child_process");
const net = require("node:net");
const http = require("node:http");
const https = require("node:https");
const tls = require("node:tls");

const logPath = process.env.MSTAR_NO_PROVIDER_LOG;
if (!logPath) throw new Error("remote-no-provider guard: MSTAR_NO_PROVIDER_LOG is required");
const sentinel = process.env.MSTAR_NO_PROVIDER_SENTINEL ?? "";
const append = fs.appendFileSync;

const realpathSync = fs.realpathSync;
const statSync = fs.statSync;
const fstatSync = fs.fstatSync;

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

function pathArgument(target) {
  if (typeof target === "string") return target;
  if (Buffer.isBuffer(target)) return target.toString();
  if (target instanceof URL) {
    try { return fileURLToPath(target); } catch { return null; }
  }
  return null;
}

function canonicalPath(target) {
  const raw = pathArgument(target);
  if (raw === null || raw === "") return null;
  try { return realpathSync(raw); } catch { return path.resolve(raw); }
}

const sentinelPath = canonicalPath(sentinel);
const sentinelStat = sentinel === "" ? null : (() => {
  try { return statSync(sentinel); } catch { return null; }
})();

function namesSentinel(target) {
  return sentinelPath !== null && canonicalPath(target) === sentinelPath;
}

function descriptorIsSentinel(handle) {
  const fd = typeof handle === "number" ? handle : (handle !== null && typeof handle === "object" && typeof handle.fd === "number" ? handle.fd : null);
  if (sentinelStat === null || fd === null) return false;
  try {
    const stat = fstatSync(fd);
    return stat.dev === sentinelStat.dev && stat.ino === sentinelStat.ino;
  } catch { return false; }
}

function guardPath(name, holder) {
  const original = holder[name];
  if (typeof original !== "function") return;
  holder[name] = function guardedPath(file, ...rest) {
    if (namesSentinel(file)) record("fs:credential-read", file);
    return original.call(holder, file, ...rest);
  };
}

function copiesSentinel(target) {
  if (sentinelPath === null) return false;
  const resolved = canonicalPath(target);
  if (resolved === null) return false;
  const prefix = resolved.endsWith(path.sep) ? resolved : `${resolved}${path.sep}`;
  return resolved === sentinelPath || sentinelPath.startsWith(prefix);
}

function guardCopy(name, holder) {
  const original = holder[name];
  if (typeof original !== "function") return;
  holder[name] = function guardedCopy(source, ...rest) {
    if (copiesSentinel(source)) record("fs:credential-read", source);
    return original.call(holder, source, ...rest);
  };
}

function guardDescriptor(name, holder) {
  const original = holder[name];
  if (typeof original !== "function") return;
  holder[name] = function guardedDescriptor(handle, ...rest) {
    if (descriptorIsSentinel(handle)) record("fs:credential-read", handle);
    return original.call(holder, handle, ...rest);
  };
}

guardPath("readFileSync", fs);
guardPath("readFile", fs);
guardPath("openSync", fs);
guardPath("open", fs);
guardPath("createReadStream", fs);
guardPath("copyFileSync", fs);
guardPath("copyFile", fs);
guardCopy("cpSync", fs);
guardPath("readFile", fs.promises);
guardPath("open", fs.promises);
guardPath("copyFile", fs.promises);
guardCopy("cp", fs.promises);
guardDescriptor("readvSync", fs);
guardDescriptor("readv", fs);
guardDescriptor("readv", fs.promises);

const allowedGit = process.env.MSTAR_NO_PROVIDER_GIT ?? "";

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

function spawnOptions(rest) {
  const last = rest[rest.length - 1];
  return last !== null && typeof last === "object" && !Array.isArray(last) ? last : {};
}

function guardSpawn(name) {
  const original = childProcess[name];
  childProcess[name] = function guardedSpawn(command, ...rest) {
    const options = spawnOptions(rest);
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

require("node:module").syncBuiltinESMExports();
