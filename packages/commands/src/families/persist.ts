import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  persistPayloadContracts,
  createFsStore,
  getArtifactStore,
  guardInjectedStore,
  loadStoreModule,
  readCoordinatedArtifact,
  replaceCoordinatedArtifact,
  resolveProcessHarnessDir,
  validateMstarReviewV1,
  validateStatusV2,
  validateWorkflowSnapshot,
  type ArtifactStore,
} from "@mstar-harness/engine";
import { z } from "zod";
import { refusalEnvelope } from "../envelope.js";
import { commandEnvelopeSchema } from "../definitions.js";
import type { CommandDefinition, CommandEnvelope } from "../types.js";

const kinds = ["status", "snapshot", "review", "json"] as const;
const kindSchema = z.enum(kinds);
type PersistKind = (typeof kinds)[number];
function payloadSchema(fields: Readonly<Record<string, { readonly required: boolean; readonly type: string }>>): z.ZodType {
  const shape = Object.fromEntries(Object.entries(fields).map(([name, field]) => {
    const value = field.type === "string" ? z.string() : field.type === "number" ? z.number() : field.type === "array" ? z.array(z.unknown()) : field.type === "object" ? z.record(z.string(), z.unknown()) : z.unknown();
    return [name, field.required ? value : value.optional()];
  }));
  return z.object(shape).passthrough();
}

const payloadContracts = persistPayloadContracts();

const payloadSchemas = {
  status: { schema: payloadSchema(payloadContracts.status.schema), help: "Status v2 root payload; required fields and full invariants are validated by the engine." },
  snapshot: { schema: payloadSchema(payloadContracts.snapshot.schema), help: "Workflow snapshot payload; conditional lifecycle, row and lease rules are validated by the engine." },
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
  let gate;
  if (kind === "status") gate = validateStatusV2(payload as Parameters<typeof validateStatusV2>[0]);
  else if (kind === "snapshot") gate = validateWorkflowSnapshot(payload);
  else if (kind === "review") gate = validateMstarReviewV1(payload);
  else return;
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
    return refusalEnvelope({ command: command, status: "refused", code: "persist.kind-retired", exitCode: 1, message: "persist residuals is retired; the issue store is the only findings authority", recovery: "Use `mstar issue list` and the issue close/waive/duplicate/supersede operations to manage findings in the issue store." });
  }
  return refusalEnvelope({ command: command, status: "usage", code: "command.invalid-input", exitCode: 2, message: "kind must be status, snapshot, review, or json" });
}

function readPayload(input: string | undefined, file: string | undefined, cwd: string, command: string): string | CommandEnvelope<never> {
  if (input !== undefined && file !== undefined) return refusalEnvelope({ command: command, status: "usage", code: "command.invalid-input", exitCode: 2, message: "input and file are mutually exclusive" });
  if (input !== undefined) return input;
  if (file === undefined) return refusalEnvelope({ command: command, status: "usage", code: "command.invalid-input", exitCode: 2, message: "provide input or file; protocol stdin is never read implicitly" });
  const requested = path.isAbsolute(file) ? file : path.resolve(cwd, file);
  if (!existsSync(requested)) return refusalEnvelope({ command: command, status: "refused", code: "persist.input-file-not-found", exitCode: 1, message: `persist payload file not found: ${requested}`, recovery: "Create or select the payload file at the reported path, then rerun the persist operation." });
  try {
    return readFileSync(requested, "utf8");
  } catch (error) {
    return refusalEnvelope({ command: command, status: "refused", code: "persist.input-read-failed", exitCode: 1, message: messageOf(error), recovery: "Check that the reported payload path is readable, then rerun the persist operation." });
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
          { key: "session", flags: "--session <path>", required: false },
        ],
      },
      input: z.object({ kind: z.string(), key: z.string().min(1), input: z.string().optional(), file: z.string().optional(), store: z.string().optional(), schema: z.string().optional(), session: z.string().optional() }),
      payloads: Object.fromEntries(Object.entries(payloadSchemas).map(([kind, descriptor]) => [
        kind,
        { schema: descriptor.schema, help: descriptor.help },
      ])),
      output, effects: ["write"], description: "Replace one authored JSON document (last write wins); coordinated authority requires its scoped writers.",
      async execute(input, context) {
        const id = "persist.write";
        const kind = parseKind(input.kind, id);
        if (isFailure(kind)) return kind;
        if (input.key === "") return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: "key must be non-empty" });
        const keyProblem = invalidKey(kind, input.key);
        if (keyProblem !== null) return refusalEnvelope({ command: id, status: "refused", code: "persist.key-refused", exitCode: 1, message: keyProblem, recovery: "Choose a key that satisfies the reported key constraints, then rerun the persist operation." });
        const raw = readPayload(input.input, input.file, context.cwd, id);
        if (typeof raw !== "string") return raw;
        let payload: unknown;
        try { payload = JSON.parse(raw); } catch (error) { return refusalEnvelope({ command: id, status: "refused", code: "persist.invalid-json", exitCode: 1, message: `persist payload is not valid JSON: ${messageOf(error)}`, recovery: "Fix the JSON syntax error in the payload file and rerun the persist operation." }); }
        try {
          validatePayload(kind, payload);
          const coordinated = kind === "status" || kind === "snapshot";
          const sessionPath = input.session;
          if (!coordinated && sessionPath !== undefined) return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: "session applies only to coordinated snapshot artifacts" });
          if (coordinated && input.schema !== undefined) return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: `schema does not apply to coordinated ${kind} replacement` });
          if (kind === "snapshot" && sessionPath === undefined) return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: "coordinated snapshot replacement requires a coordinator session" });
          if (sessionPath !== undefined && !path.isAbsolute(sessionPath)) return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: "session must be an absolute path" });
          if (kind === "status" && sessionPath !== undefined) return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: "session applies to snapshot replacement only" });
          const store = await resolveStore(input.store, context.cwd);
          if (coordinated) {
            const root = (store as ArtifactStore & { root?: unknown }).root;
            if (typeof root !== "string") return refusalEnvelope({ command: id, status: "refused", code: "coordination.local-store-required", exitCode: 1, message: "coordinated replacement requires the local FsStore", recovery: "Use the local FsStore for coordinated status or snapshot replacement, then rerun the persist operation." });
            await replaceCoordinatedArtifact({
              harnessRoot: root,
              ref: { kind: kind as "status" | "snapshot", key: input.key },
              payload,
              ...(sessionPath === undefined ? {} : { sessionPath }),
            });
          } else {
            await store.put({ kind, key: input.key, payload, ...(input.schema === undefined ? {} : { schema: input.schema }) });
          }
          return ok(id, { kind, key: input.key });
        } catch (error) {
          return refusalEnvelope({ command: id, status: "refused", code: "persist.write-refused", exitCode: 1, message: messageOf(error), details: { underlyingCode: errorCode(error, "persist.write-refused") }, recovery: "Correct the reported write failure (including any invalid payload or store condition), then rerun the persist operation." });
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
        if (keyProblem !== null) return refusalEnvelope({ command: id, status: "refused", code: "persist.key-refused", exitCode: 1, message: keyProblem, recovery: "Choose a key that satisfies the reported key constraints, then rerun the persist operation." });
        try {
          const store = await resolveStore(input.store, context.cwd);
          if (input.versioned === true) {
            const root = (store as ArtifactStore & { root?: unknown }).root;
            if (typeof root !== "string") return refusalEnvelope({ command: id, status: "refused", code: "coordination.local-store-required", exitCode: 1, message: "versioned reads require the local FsStore", recovery: "Use the local FsStore for versioned reads, then rerun the persist operation." });
            const read = await readCoordinatedArtifact(root, { kind, key: input.key });
            return ok(id, { payload: read.payload ?? null, version: read.version });
          }
          const payload = await store.get({ kind, key: input.key });
          if (payload === undefined) return refusalEnvelope({ command: id, status: "refused", code: "persist.not-found", exitCode: 1, message: `persist get ${kind}/${input.key}: no stored document`, recovery: "Write the document with `mstar persist write` or select an existing kind/key, then rerun the read." });
          if (input.validate === true) {
            validatePayload(kind, payload);
            return ok(id, { payload, validation: kind === "json" ? "parse-only" : "ok" });
          }
          return ok(id, { payload });
        } catch (error) {
          return refusalEnvelope({ command: id, status: "refused", code: "persist.get-refused", exitCode: 1, message: messageOf(error), details: { underlyingCode: errorCode(error, "persist.get-refused") }, recovery: "Correct the reported store or validation failure, then rerun the persist read." });
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
          return refusalEnvelope({ command: id, status: "refused", code: "persist.list-refused", exitCode: 1, message: messageOf(error), details: { underlyingCode: errorCode(error, "persist.list-refused") }, recovery: "Correct the reported store failure, then rerun the persist list operation." });
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
        if (keyProblem !== null) return refusalEnvelope({ command: id, status: "refused", code: "persist.key-refused", exitCode: 1, message: keyProblem, recovery: "Choose a key that satisfies the reported key constraints, then rerun the persist operation." });
        try {
          const store = await resolveStore(input.store, context.cwd);
          if (typeof store.delete !== "function") return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: "store does not support delete" });
          await store.delete({ kind, key: input.key });
          return ok(id, { kind, key: input.key, deleted: true });
        } catch (error) {
          return refusalEnvelope({ command: id, status: "refused", code: "persist.delete-refused", exitCode: 1, message: messageOf(error), details: { underlyingCode: errorCode(error, "persist.delete-refused") }, recovery: "Correct the reported store or key failure, then rerun the persist delete operation." });
        }
      },
    }),
  ];
}
