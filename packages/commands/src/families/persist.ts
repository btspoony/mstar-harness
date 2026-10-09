import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  persistPayloadContracts,
  createFsStore,
  getArtifactStore,
  guardInjectedStore,
  loadStoreModule,
  resolveArtifactPath,
  resolveProcessHarnessDir,
  validateMstarReviewV1,
  type ArtifactStore,
} from "@mstar-harness/engine";
import { z } from "zod";
import { refusalEnvelope } from "../envelope.js";
import { commandEnvelopeSchema } from "../definitions.js";
import type { CommandDefinition, CommandEnvelope } from "../types.js";

const payloadContracts = persistPayloadContracts();
const kinds = Object.keys(payloadContracts) as ["review", "json"];
const kindSchema = z.enum(kinds);
type PersistKind = (typeof kinds)[number];
function payloadSchema(fields: Readonly<Record<string, { readonly required: boolean; readonly type: string }>>): z.ZodType {
  const shape = Object.fromEntries(Object.entries(fields).map(([name, field]) => {
    const value = field.type === "string" ? z.string() : field.type === "number" ? z.number() : field.type === "array" ? z.array(z.unknown()) : field.type === "object" ? z.record(z.string(), z.unknown()) : z.unknown();
    return [name, field.required ? value : value.optional()];
  }));
  return z.object(shape).passthrough();
}


const payloadSchemas = {
  review: { schema: payloadSchema(payloadContracts.review.schema), help: "mstar.review/v1 envelope; finding, tally and verdict invariants are validated by the engine." },
  json: { schema: z.unknown(), help: `${payloadContracts.json.reason} ${payloadContracts.json.alternative}` },
} as const;

function ok<T>(command: string, data: T): CommandEnvelope<T> {
  return { version: 1, command, status: "ok", code: "persist.ok", exitCode: 0, data };
}


function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The one key contract for every persist verb (write / get / delete). A key is
 * a **logical name inside a kind**, never a path: `json` is the single kind
 * whose key is an absolute path (the store contract's escape hatch), and even
 * there the store refuses `..` segments. Everything else must be a single safe
 * component, so a key can neither climb out of its `kind/` namespace nor be
 * silently reinterpreted as one. Returns the refusal message, or `null` when
 * the key is admissible. The empty key is handled by the caller as a usage
 * error (its pre-existing classification).
 *
 * The refusals are phrased as the store's own, because this is the same rule
 * applied one layer earlier: the adapter rejects a key the store would have
 * rejected anyway, before any payload is read.
 */
function invalidKey(kind: PersistKind, key: string): string | null {
  if (key === "") return null;
  const segments = key.split(/[\\/]+/);
  if (kind === "json") {
    if (!path.isAbsolute(key)) return `json key must be an absolute path \u2014 got ${JSON.stringify(key)}`;
    if (segments.includes("..")) return `json key must not contain ".." segments \u2014 got ${JSON.stringify(key)}`;
    return null;
  }
  if (segments.includes("..")) return `${kind} key must not contain ".." segments \u2014 got ${JSON.stringify(key)}`;
  if (path.isAbsolute(key) || segments.length > 1 || key === "." || !/^[A-Za-z0-9._-]+$/.test(key)) {
    return `${kind} key must be a single safe path component ([A-Za-z0-9._-]+; not "", ".", "..", or containing "/" or "\\") \u2014 got ${JSON.stringify(key)}`;
  }
  return null;
}

function errorCode(error: unknown, fallback: string): string {
  return error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : fallback;
}

function validatePayload(kind: PersistKind, payload: unknown): void {
  if (kind !== "review") return;
  const gate = validateMstarReviewV1(payload);
  if (!gate.ok) throw new Error(`refusing to persist invalid ${kind} document: ${gate.violations.map((v) => `[${v.severity}] ${v.code}: ${v.message}`).join("; ")}`);
}

async function resolveStore(storeFlag: string | undefined, cwd: string): Promise<ArtifactStore> {
  if (storeFlag !== undefined) return guardInjectedStore(await loadStoreModule(storeFlag));
  const envStore = process.env.MSTAR_STORE_MODULE;
  if (envStore !== undefined) return guardInjectedStore(await loadStoreModule(envStore));
  const harnessDir = resolveProcessHarnessDir(cwd);
  return harnessDir === null ? getArtifactStore() : createFsStore(harnessDir);
}

function parseKind(kind: unknown, command: string): PersistKind | CommandEnvelope<never> {
  const parsed = kindSchema.safeParse(kind);
  if (parsed.success) return parsed.data;
  if (kind === "residuals") {
    return refusalEnvelope({ command: command, status: "refused", code: "persist.kind-retired", exitCode: 1, message: "persist residuals is retired; the issue store is the only findings authority", recovery: "The issue store is the sole findings authority; inspect registered findings with mstar issue list before using an issue lifecycle operation." });
  }
  return refusalEnvelope({ command: command, status: "usage", code: "command.invalid-input", exitCode: 2, message: "kind must be review or json" });
}

function readPayload(input: string | undefined, file: string | undefined, cwd: string, command: string): string | CommandEnvelope<never> {
  if (input !== undefined && file !== undefined) return refusalEnvelope({ command: command, status: "usage", code: "command.invalid-input", exitCode: 2, message: "input and file are mutually exclusive" });
  if (input !== undefined) return input;
  if (file === undefined) return refusalEnvelope({ command: command, status: "usage", code: "command.invalid-input", exitCode: 2, message: "provide input or file; protocol stdin is never read implicitly" });
  const requested = path.isAbsolute(file) ? file : path.resolve(cwd, file);
  if (!existsSync(requested)) return refusalEnvelope({ command: command, status: "refused", code: "persist.input-file-not-found", exitCode: 1, message: `persist payload file not found: ${requested}`, recovery: "The payload file must exist at the reported path and be readable; retry the same persist write with that file." });
  try {
    return readFileSync(requested, "utf8");
  } catch (error) {
    return refusalEnvelope({ command: command, status: "refused", code: "persist.input-read-failed", exitCode: 1, message: messageOf(error), recovery: "Make the payload file readable at the reported path and retry the same persist write." });
  }
}

function command<I, O>(definition: CommandDefinition<I, O>): CommandDefinition<I, O> {
  return definition;
}

function isFailure(value: unknown): value is CommandEnvelope<never> {
  return value !== null && typeof value === "object" && "status" in value && value.status !== "ok";
}


export function getPersistCommandDefinitions(): readonly CommandDefinition[] {
  const output = commandEnvelopeSchema;
  return [
    command({
      id: "persist.write",
      cli: {
        path: ["persist", "write"], aliases: [], arguments: [{ key: "kind", required: true, variadic: false, choices: kinds }],
        options: [
          { key: "key", flags: "--key <key>", required: true },
          { key: "input", flags: "--input <json>", required: false },
          { key: "file", flags: "--file <path>", required: false },
          { key: "store", flags: "--store <module>", required: false },
          { key: "schema", flags: "--schema <id>", required: false },
        ],
      },
      input: z.object({ kind: z.string(), key: z.string().min(1), input: z.string().optional(), file: z.string().optional(), store: z.string().optional(), schema: z.string().optional() }),
      payloads: Object.fromEntries(Object.entries(payloadSchemas).map(([kind, descriptor]) => [
        kind,
        { schema: descriptor.schema, help: descriptor.help },
      ])),
      output, effects: ["write"], description: "Replace one persisted review or JSON document.",
      async execute(input, context) {
        const id = "persist.write";
        const kind = parseKind(input.kind, id);
        if (isFailure(kind)) return kind;
        if (input.key === "") return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: "key must be non-empty" });
        const keyProblem = invalidKey(kind, input.key);
        if (keyProblem !== null) return refusalEnvelope({ command: id, status: "refused", code: "persist.key-refused", exitCode: 1, message: keyProblem, recovery: "Correct the key using the supported persist kind and key constraints, then retry." });
        const raw = readPayload(input.input, input.file, context.cwd, id);
        if (typeof raw !== "string") return raw;
        let payload: unknown;
        try { payload = JSON.parse(raw); } catch (error) { return refusalEnvelope({ command: id, status: "refused", code: "persist.invalid-json", exitCode: 1, message: `persist payload is not valid JSON: ${messageOf(error)}`, recovery: "Correct the JSON syntax and retry with the same persist kind and key." }); }
        try {
          validatePayload(kind, payload);
          const store = await resolveStore(input.store, context.cwd);
          await store.put({ kind, key: input.key, payload, ...(input.schema === undefined ? {} : { schema: input.schema }) });
          return ok(id, { kind, key: input.key });
        } catch (error) {
          return refusalEnvelope({ command: id, status: "refused", code: "persist.write-refused", exitCode: 1, message: messageOf(error), details: { underlyingCode: errorCode(error, "persist.write-refused") }, recovery: "Correct the reported store or payload issue, then retry the same persist write." });
        }
      },
    }),
    command({
      id: "persist.get",
      cli: { path: ["persist", "get"], aliases: [], arguments: [{ key: "kind", required: true, variadic: false, choices: kinds }], options: [{ key: "key", flags: "--key <key>", required: true }, { key: "validate", flags: "--validate", required: false }, { key: "versioned", flags: "--versioned", required: false }, { key: "store", flags: "--store <module>", required: false }] },
      input: z.object({ kind: z.string(), key: z.string().min(1), validate: z.boolean().optional(), versioned: z.boolean().optional(), store: z.string().optional() }),
      output, effects: ["read"], description: "Read one persisted document.",
      async execute(input, context) {
        const id = "persist.get";
        const kind = parseKind(input.kind, id);
        if (isFailure(kind)) return kind;
        if (input.key === "") return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: "key must be non-empty" });
        const keyProblem = invalidKey(kind, input.key);
        if (keyProblem !== null) return refusalEnvelope({ command: id, status: "refused", code: "persist.key-refused", exitCode: 1, message: keyProblem, recovery: "Correct the key using the supported persist kind and key constraints, then retry." });
        try {
          const store = await resolveStore(input.store, context.cwd);
          if (input.versioned === true) {
            const root = (store as ArtifactStore & { root?: unknown }).root;
            if (typeof root !== "string") return refusalEnvelope({ command: id, status: "refused", code: "coordination.local-store-required", exitCode: 1, message: "versioned reads require the local FsStore", recovery: "Use the local FsStore for a versioned read, or omit --versioned for an injected store." });
            const ref = { kind, key: input.key };
            const payload = await store.get(ref);
            if (payload === undefined) return ok(id, { payload: null, version: "absent" });
            const bytes = readFileSync(resolveArtifactPath(root, ref));
            return ok(id, { payload: JSON.parse(bytes.toString("utf8")), version: `sha256:${createHash("sha256").update(bytes).digest("hex")}` });
          }
          const payload = await store.get({ kind, key: input.key });
          if (payload === undefined) return refusalEnvelope({ command: id, status: "refused", code: "persist.not-found", exitCode: 1, message: `persist get ${kind}/${input.key}: no stored document`, recovery: `Create it with mstar persist write ${kind} --key ${input.key} --input <json>, then read it with mstar persist get ${kind} --key ${input.key}.` });
          if (input.validate === true) {
            validatePayload(kind, payload);
            return ok(id, { payload, validation: kind === "json" ? "parse-only" : "ok" });
          }
          return ok(id, { payload });
        } catch (error) {
          return refusalEnvelope({ command: id, status: "refused", code: "persist.get-refused", exitCode: 1, message: messageOf(error), details: { underlyingCode: errorCode(error, "persist.get-refused") }, recovery: "Correct the reported store or validation failure and retry the same persist get." });
        }
      },
    }),
    command({
      id: "persist.list",
      cli: { path: ["persist", "list"], aliases: [], arguments: [{ key: "kind", required: true, variadic: false, choices: kinds }], options: [{ key: "store", flags: "--store <module>", required: false }] },
      input: z.object({ kind: z.string(), store: z.string().optional() }), output, effects: ["read"], description: "List persisted keys.",
      async execute(input, context) {
        const id = "persist.list";
        const kind = parseKind(input.kind, id);
        if (isFailure(kind)) return kind;
        if (kind === "json") return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: "ArtifactStore json keys are absolute paths and cannot be listed" });
        try {
          const store = await resolveStore(input.store, context.cwd);
          if (typeof store.list !== "function") return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: "store does not support list" });
          const refs = await store.list(kind);
          return ok(id, refs.map(({ key }) => key).sort());
        } catch (error) {
          return refusalEnvelope({ command: id, status: "refused", code: "persist.list-refused", exitCode: 1, message: messageOf(error), details: { underlyingCode: errorCode(error, "persist.list-refused") }, recovery: "Correct the reported store failure, then retry listing the same persist kind." });
        }
      },
    }),
    command({
      id: "persist.delete",
      cli: { path: ["persist", "delete"], aliases: [], arguments: [{ key: "kind", required: true, variadic: false, choices: kinds }], options: [{ key: "key", flags: "--key <key>", required: true }, { key: "store", flags: "--store <module>", required: false }] },
      input: z.object({ kind: z.string(), key: z.string().min(1), store: z.string().optional() }), output, effects: ["write"], description: "Delete one persisted document.",
      async execute(input, context) {
        const id = "persist.delete";
        const kind = parseKind(input.kind, id);
        if (isFailure(kind)) return kind;
        if (input.key === "") return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: "key must be non-empty" });
        const keyProblem = invalidKey(kind, input.key);
        if (keyProblem !== null) return refusalEnvelope({ command: id, status: "refused", code: "persist.key-refused", exitCode: 1, message: keyProblem, recovery: "Correct the key using the supported persist kind and key constraints, then retry." });
        try {
          const store = await resolveStore(input.store, context.cwd);
          if (typeof store.delete !== "function") return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: "store does not support delete" });
          await store.delete({ kind, key: input.key });
          return ok(id, { kind, key: input.key, deleted: true });
        } catch (error) {
          return refusalEnvelope({ command: id, status: "refused", code: "persist.delete-refused", exitCode: 1, message: messageOf(error), details: { underlyingCode: errorCode(error, "persist.delete-refused") }, recovery: "Correct the reported store or key failure and retry the same persist delete." });
        }
      },
    }),
  ];
}
