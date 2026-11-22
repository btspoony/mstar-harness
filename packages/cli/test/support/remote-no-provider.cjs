/**
 * Test-only preload: deny and RECORD every outbound provider channel a CLI child
 * could open. It is loaded with `NODE_OPTIONS=--require` into the built CLI, so a
 * regression that reaches the network, a provider credential outside the sandbox,
 * or a non-Git subprocess fails the child instead of silently passing the suite.
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

const isGit = (command) => path.basename(String(command)) === "git";
function guardSpawn(name) {
  const original = childProcess[name];
  childProcess[name] = function guardedSpawn(command, ...rest) {
    if (!isGit(command)) record("spawn", command);
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
