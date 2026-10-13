import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { ExecutionError, withExecutionTransaction } from "./execution-store.js";
import { storeDbPath, StoreError, withExecutionReadGuard, type StoreContext } from "./store-db.js";
import { importDshHostStateRows, type DshHostStateRefusal, type DshHostStateRows } from "./host-state-store.js";
const FLOW = "agent-flow.jsonl";
const IDS = "agent-flow-ids.jsonl";
const CURSORS = "workflow-ledger-cursors.json";
const JOURNAL = "agent-flow-compaction.json";
const HISTORY = "agent-flow-history";
const SNAPSHOTS = "snapshots";
const STATUS = "engine-status.json";
const DIGEST = /^[0-9a-f]{64}$/;
const CHUNK = /^chunk-[0-9]{6}\.jsonl$/;
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const nonBlankLines = (bytes: Buffer) => bytes.toString("utf8").split("\n").filter((line) => line.trim() !== "").length;

type Finding = Record<string, unknown> & { source: string };
type Refusal = DshHostStateRefusal;
export type DshHostStateImportReport = {
  verdict: "imported" | "partially-imported" | "nothing-to-import";
  imported: { workflows: number; identities: number; ledgerRows: number; scanBounds: number; bindings: number; emissions: number };
  merged: { scanBoundsAdvanced: number; bindingFloorsRaised: number };
  findings: Finding[];
  sourceDigest: string;
};
type Evaluation = { rows: DshHostStateRows; findings: Finding[]; refusals: Refusal[]; sourceDigest: string };

function refused(refusals: readonly Refusal[]): never {
  throw new StoreError("store.upgrade-dsh-source-refused", `store upgrade refused: ${refusals.length} legacy DSH host-state fact group(s) could not be imported.\n${refusals.map((r) => `- ${r.selector}: ${r.facts} \u2014 ${r.discarded}: ${r.reason}`).join("\n")}\nRecovery (supported path): rerun \`mstar store upgrade\` with \`--ack-skip-dsh <selector>\` for each listed selector. The invocation imports every other decidable fact and drops exactly the refused facts for acknowledged selectors. Original bytes remain unchanged; ordinary upgrade remains retryable.`);
}

/** Loss disclosure keyed by the actual fact category, never by a filename substring. */
function lossStatement(refusal: Refusal): string {
  switch (refusal.category) {
    case "workflows":
      return "Loss: the legacy workflow tree at the named source was not read (a symlinked source tree is never followed), so no legacy identity, display row or scan bound under it imports; consumers may require a workflow re-pick or may backfill rows below the old exclusion floor.";
    case "status":
      return "Loss: legacy session bindings (workflow picks, execution witnesses, and exclusion floors) and newest emissions were not imported; consumers may require a workflow re-pick or may backfill rows below the old exclusion floor.";
    case "bounds":
      return "Loss: the named workflow's legacy scan bounds were not imported; affected sessions re-scan native session logs, verified identities replay as no-ops, and duplicate live evidence rows remain possible.";
    case "registry":
      return `Loss: ${refusal.discarded}. The whole parsed registry is discarded, so no accepted identity from this source registers and a later native replay of the same event id would be accepted again (dedup limitation); the coupled display tail is withheld because its identities cannot be verified. Scan bounds are an independent fact.`;
    case "tail":
      return `Loss: ${refusal.discarded}. These held-back display rows never appear. Verified identities and scan bounds are independent facts and import per their own rules.`;
    case "identity":
      return `Loss: ${refusal.discarded}. This historical conflicting legacy digest is not registered; the existing native accepted identity and its replay behavior are unchanged \u2014 a same-digest native replay stays deduplicated and a different-digest replay stays a conflict. Every other identity, the tail and the scan bounds are unaffected.`;
  }
}

/**
 * Read one regular file through ONE descriptor: the leaf is opened without
 * following a final symlink and WITHOUT blocking, the same descriptor is
 * verified with `fstat`, read and closed, so a path swapped for a link after
 * any earlier ancestor check can never contribute another file's bytes and a
 * leaf that is not a regular file refuses by type instead of hanging the
 * command. Where a platform does not provide `O_NOFOLLOW`, the same-descriptor
 * `fstat` verification remains the boundary.
 */
function readBytes(path: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`not a regular file: ${path}`);
    return readFileSync(fd);
  } finally { closeSync(fd); }
}
/** Read a child only through a verified, non-symlinked ancestor directory. */
function readInside(parent: string, child: string): Buffer {
  const st = lstatSync(parent);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`unsafe ancestor directory: ${parent}`);
  return readBytes(join(parent, child));
}

function evaluate(context: StoreContext, now: string): Evaluation {
  const root = dirname(storeDbPath(context));
  const allFiles: Array<[string, string]> = [];
  const workflows: DshHostStateRows["workflows"][number][] = [];
  const findings: Finding[] = [];
  const refusals: Refusal[] = [];
  const dirs = join(root, "workflows");
  try {
    const rootInfo = lstatSync(dirs);
    // A symlinked source tree is never followed: nothing under it is readable
    // through that path, so the whole source refuses as one acknowledged unit
    // instead of reporting nothing to import. A real non-directory is not a
    // legacy body source and stays a non-source.
    if (rootInfo.isSymbolicLink()) refusals.push({
      selector: "dsh-workflows", category: "workflows",
      facts: "the legacy host-state source tree", discarded: "every legacy DSH fact under workflows/",
      reason: "the workflows root is a symlink and is never followed", source: "workflows",
    });
    else if (!rootInfo.isDirectory()) findings.push({ source: "workflows", kind: "ignored" });
    else for (const entry of readdirSync(dirs, { withFileTypes: true })) {
      const dir = join(dirs, entry.name), source = `workflows/${entry.name}`;
      // Same no-follow rule per workflow: no fact of this workflow is
      // decidable, so it refuses as one source-scoped unit.
      if (entry.isSymbolicLink()) {
        refusals.push({
          selector: `dsh-ledger:${entry.name}`, category: "workflows",
          facts: "this workflow's legacy host-state facts",
          discarded: `the legacy identity registry, display tail and scan bounds of ${entry.name}`,
          reason: "the workflow directory is a symlink and is never followed", source,
        });
        continue;
      }
      if (!entry.isDirectory()) { findings.push({ source, kind: "ignored" }); continue; }
      const names = [FLOW, IDS, CURSORS, JOURNAL];
      const present: Record<string, Buffer> = {};
      const unreadable = new Set<string>();
      for (const name of names) {
        try { const b = readBytes(join(dir, name)); present[name] = b; allFiles.push([`${source}/${name}`, hash(b)]); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") unreadable.add(name); }
      }
      const knownIndexLines = present[IDS] ? present[IDS]!.toString("utf8").split("\n").filter((line) => line.trim() !== "").length : 0;
      const knownTailLines = present[FLOW] ? nonBlankLines(present[FLOW]!) : 0;
      const registryLoss = `the entire accepted-identity registry for ${entry.name} (${knownIndexLines} index line(s) present) and the coupled display tail (${knownTailLines} non-blank line(s) present) were discarded`;

      // One parse of the display tail. A durable workflow row carries its own
      // `wfe1:` id and the digest its producer recorded for the identity index
      // (sha256 of the serialized line, first 32 hex chars) is recoverable from
      // the retained line itself; a line that cannot be parsed but still names
      // that namespace is a torn native row whose identity is undecidable.
      const tailRows: Array<{ eventId: string | null; lineJson: string; lineIndex: number }> = [];
      const tailIdentities = new Map<string, string>();
      let tailUndecidable: string | null = null;
      if (present[FLOW] !== undefined) {
        for (const [i, line] of present[FLOW]!.toString("utf8").split("\n").entries()) {
          if (line.trim() === "") continue;
          let eventId: string | null = null;
          try {
            const parsed: unknown = JSON.parse(line);
            const id = parsed !== null && typeof parsed === "object" && "eventId" in parsed ? parsed.eventId : undefined;
            if (typeof id === "string") eventId = id;
          } catch { if (line.includes('"wfe1:')) tailUndecidable = `display-tail line ${i + 1} names a native event identity but is not a parseable row`; }
          tailRows.push({ eventId, lineJson: line, lineIndex: i + 1 });
          if (eventId !== null && eventId.startsWith("wfe1:")) {
            const digest = hash(line).slice(0, 32);
            const prior = tailIdentities.get(eventId);
            if (prior !== undefined && prior !== digest) tailUndecidable = `the display tail holds native identity ${eventId} with two different byte sets`; // hash-gate: authorized — Reject a retained tail that carries one native identity under two different byte sets.
            else tailIdentities.set(eventId, digest);
          }
          if (tailUndecidable !== null) break;
        }
      }

      // Retained-history completeness: an unsafe or unreadable history ancestor is
      // never followed for any purpose (identity completeness or archive proof).
      const historyIdentities = new Map<string, string>();
      let historySafe = true;
      const historyDir = join(dir, HISTORY);
      // Only the initial missing-directory case means "this workflow kept no
      // history": a chunk that vanishes AFTER it was enumerated leaves the
      // archive incomplete, so its identities cannot be checked and the
      // completeness guard must refuse instead of silently importing the index.
      let historyEnumerated = false;
      try {
        const hs = lstatSync(historyDir);
        if (hs.isSymbolicLink() || !hs.isDirectory()) { historySafe = false; throw new Error("history path is not a real directory"); }
        historyEnumerated = true;
        for (const h of readdirSync(historyDir).filter((n) => n.startsWith("chunk-") && n.endsWith(".jsonl")).sort()) {
          const b = readBytes(join(historyDir, h)); allFiles.push([`${source}/${HISTORY}/${h}`, hash(b)]);
          for (const line of b.toString("utf8").split("\n")) if (line) {
            try {
              const parsed: unknown = JSON.parse(line);
              const eventId = parsed && typeof parsed === "object" && "eventId" in parsed ? parsed.eventId : undefined;
              if (typeof eventId === "string" && eventId.startsWith("wfe1:")) {
                const digest = hash(line).slice(0, 32);
                const prior = historyIdentities.get(eventId);
                if (prior !== undefined && prior !== digest) throw new Error(`conflicting archived identity ${eventId}`); // hash-gate: authorized — Reject conflicting archived bytes for the same stable native event identity during legacy import.
                historyIdentities.set(eventId, digest);
              }
            } catch { historySafe = false; throw new Error("retained history holds an unparseable line"); }
          }
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT" || historyEnumerated) {
          historySafe = false;
          refusals.push({ selector: `dsh-ledger:${entry.name}`, category: "registry", facts: "identity history completeness", discarded: registryLoss, reason: "retained history could not be completely validated", source });
        }
      }

      const identityRows: Array<{ eventId: string; digest: string; acceptedAt: string }> = [];
      const seen = new Map<string, string>();
      let identityRefused = !historySafe || unreadable.has(IDS);
      if (unreadable.has(IDS)) refusals.push({ selector: `dsh-ledger:${entry.name}`, category: "registry", facts: "identity index", discarded: registryLoss, reason: `the identity index could not be safely read`, source });
      if (present[IDS] === undefined) {
        if (historyIdentities.size > 0) {
          identityRefused = true;
          refusals.push({ selector: `dsh-ledger:${entry.name}`, category: "registry", facts: "identities", discarded: registryLoss, reason: "the identity index is absent while retained history holds identified rows", source });
        }
      } else if (!identityRefused) {
        let malformed: string | null = null;
        for (const [i, line] of present[IDS]!.toString("utf8").split("\n").entries()) {
          if (!line) continue;
          try {
            const rec = JSON.parse(line) as { id?: unknown; d?: unknown };
            if (typeof rec.id !== "string" || !rec.id || typeof rec.d !== "string" || !rec.d) throw new Error("malformed identity line");
            const prior = seen.get(rec.id); if (prior !== undefined && prior !== rec.d) throw new Error(`conflicting duplicate identity ${rec.id}`);
            if (prior === undefined) { seen.set(rec.id, rec.d); identityRows.push({ eventId: rec.id, digest: rec.d, acceptedAt: now }); }
          } catch (e) { malformed = `index line ${i + 1}: ${String(e)}`; break; }
        }
        let uncovered: string | null = null;
        if (malformed === null) for (const [eventId, digest] of historyIdentities) {
          if (seen.get(eventId) !== digest) { uncovered = eventId; break; } // hash-gate: authorized — Require the legacy accepted-identity registry to cover each retained native event with its original digest.
        }
        if (malformed !== null || uncovered !== null) {
          identityRefused = true;
          refusals.push({
            selector: `dsh-ledger:${entry.name}`, category: "registry", facts: malformed ?? `identity ${uncovered}`,
            discarded: registryLoss,
            reason: malformed === null ? "the accepted identity index does not cover the retained history bytes" : "the identity index is not fully parseable",
            source,
          });
        }
      }
      if (identityRefused) identityRows.length = 0;

      // Display tail: the journal decision must be established without following
      // any unsafe ancestor, and an unreadable journal withholds the tail.
      const ledgerRows: Array<{ eventId: string | null; lineJson: string; lineIndex: number; recordedAt: string }> = [];
      let tailSourceDigest: string | null = null;
      let journalDecision: "clean" | "before" | "landed" | "invalid" = present[JOURNAL] === undefined ? "clean" : "invalid";
      let tailRefusal: string | null = null;
      if (unreadable.has(FLOW)) tailRefusal = "the display tail could not be safely read";
      else if (unreadable.has(JOURNAL)) tailRefusal = "the compaction journal could not be safely read, so the tail disposition cannot be resolved";
      else if (present[FLOW] === undefined && present[JOURNAL] !== undefined) tailRefusal = "a compaction journal exists without a readable display tail";
      else if (present[JOURNAL] !== undefined) {
        try {
          const parsed: unknown = JSON.parse(present[JOURNAL]!.toString("utf8"));
          const rec = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : undefined;
          const fingerprint = (value: unknown): { bytes: number; sha256: string } | undefined => {
            if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
            const bytes = (value as Record<string, unknown>).bytes, sha256 = (value as Record<string, unknown>).sha256;
            if (!Number.isSafeInteger(bytes) || (bytes as number) < 0) return undefined;
            if (typeof sha256 !== "string" || !DIGEST.test(sha256)) return undefined;
            return { bytes: bytes as number, sha256 };
          };
          const before = fingerprint(rec?.tailBefore), after = fingerprint(rec?.tailAfter);
          const archive = rec?.archive && typeof rec.archive === "object" && !Array.isArray(rec.archive) ? rec.archive as Record<string, unknown> : undefined;
          const lines = rec?.lines;
          if (rec?.version !== 1 || before === undefined || after === undefined || archive === undefined) throw new Error("unrecognized compaction journal shape");
          if (typeof archive.chunk !== "string" || !CHUNK.test(archive.chunk)) throw new Error("invalid journal archive chunk");
          if (!Number.isSafeInteger(archive.offset) || (archive.offset as number) < 0) throw new Error("invalid journal archive offset");
          if (!Number.isSafeInteger(archive.bytes) || (archive.bytes as number) <= 0) throw new Error("invalid journal archive byte count");
          if (typeof archive.sha256 !== "string" || !DIGEST.test(archive.sha256)) throw new Error("invalid journal archive digest");
          if (!Number.isSafeInteger(lines) || (lines as number) < 1) throw new Error("invalid journal line count");
          if (before.bytes <= after.bytes) throw new Error("the journal recorded no tail removal");
          const observed = { bytes: present[FLOW]!.length, sha256: hash(present[FLOW]!) };
          if (observed.bytes === before.bytes && observed.sha256 === before.sha256) journalDecision = "before"; // hash-gate: authorized — Identify the recorded pre-compaction machine tail before importing legacy display evidence.
          else if (
            observed.bytes === after.bytes &&
            // hash-gate: authorized — Identify the recorded post-compaction machine tail before requiring its archive completion proof.
            observed.sha256 === after.sha256
          ) {
            if (!historySafe) tailRefusal = "the journal's archive proof is unavailable because the retained history directory is not a safe source";
            else {
              const archived = readBytes(join(historyDir, archive.chunk as string));
              allFiles.push([`${source}/${HISTORY}/${archive.chunk}`, hash(archived)]);
              const range = archived.subarray(archive.offset as number, (archive.offset as number) + (archive.bytes as number));
              if (archived.length === (archive.offset as number) + (archive.bytes as number) && hash(range) === archive.sha256) journalDecision = "landed"; // hash-gate: authorized — Verify the exact archived machine byte range completing a landed legacy compaction before importing its tail.
              else tailRefusal = "the compaction journal archive range does not complete the recorded bytes";
            }
          } else tailRefusal = "the compaction journal is decidable neither from the observed tail nor from its archive";
        } catch (e) { tailRefusal = `the compaction journal is not a recognized transaction (${String(e)})`; }
        if (tailRefusal === null && journalDecision !== "invalid") findings.push({ source, kind: "journal", decision: journalDecision });
      }
      // A decidable journal must not outrank an undecidable tail: the real
      // filesystem/journal reasons above keep their priority, and a torn or
      // identity-conflicting tail refuses on its own once they are clear.
      if (tailRefusal === null && tailUndecidable !== null) tailRefusal = tailUndecidable;
      // A genuine tail/journal safety refusal is published whenever the tail bytes
      // are not simply absent: unreadable FLOW, a journal present without FLOW, and
      // an unreadable journal all refuse. Only a truly absent FLOW with no journal
      // and no read failure is a no-op; a readable empty FLOW is zero physical rows.
      const tailFacts = knownTailLines === 0 ? "display tail (unavailable; row count unknown)" : `tail rows (${knownTailLines})`;
      const tailLoss = `the display rows held back for ${entry.name} were not imported`;
      if (tailRefusal !== null) {
        refusals.push({ selector: `dsh-ledger:${entry.name}`, category: "tail", facts: tailFacts, discarded: tailLoss, reason: tailRefusal, source });
      } else if (present[FLOW] === undefined) {
        // No display-tail fact at all (no bytes obtainable, no journal): nothing to withhold.
      } else if (identityRefused) {
        refusals.push({ selector: `dsh-ledger:${entry.name}`, category: "tail", facts: tailFacts, discarded: tailLoss, reason: "the tail identities cannot be verified because the identity registry was refused", source });
      } else {
        const tailDigest = hash(present[FLOW]!);
        // Recovery of the legacy crash window: the writer committed the durable
        // row before its identity-index entry, so a `wfe1:` row can be retained
        // here with no registry line. Its digest is the producer's own line
        // digest, so the identity is recovered and registered together with the
        // tail evidence it belongs to; ordinary duplicate-capable display rows
        // (`wfc1:` and unidentified) never carry identity authority.
        let conflicting: string | null = null;
        for (const [eventId, digest] of tailIdentities) {
          const prior = seen.get(eventId);
          if (prior !== undefined && prior !== digest) { conflicting = eventId; break; } // hash-gate: authorized — Refuse a legacy source whose accepted-identity index and retained tail bytes disagree for one identity.
        }
        if (conflicting !== null) {
          identityRefused = true;
          identityRows.length = 0;
          refusals.push({ selector: `dsh-ledger:${entry.name}`, category: "registry", facts: `identity ${conflicting}`, discarded: registryLoss, reason: "the accepted identity index and the retained tail bytes disagree for this identity", source });
        } else {
          for (const [eventId, digest] of tailIdentities) if (!seen.has(eventId)) { seen.set(eventId, digest); identityRows.push({ eventId, digest, acceptedAt: now }); }
          for (const row of tailRows) ledgerRows.push({ eventId: row.eventId, lineJson: row.lineJson, lineIndex: row.lineIndex, recordedAt: now });
          tailSourceDigest = ledgerRows.length ? tailDigest : null;
        }
      }

      // Scan-bound sidecar: an indivisible unit — validated in full before its rows
      // are published, so a partially invalid sidecar publishes none of its bounds.
      const pendingBounds: Array<{ sessionId: string; next: number; stream: string | null }> = [];
      if (unreadable.has(CURSORS)) refusals.push({ selector: `dsh-bounds:${entry.name}`, category: "bounds", facts: "scan bounds", discarded: `every scan bound of ${entry.name}`, reason: "the cursor sidecar could not be safely read", source });
      else if (present[CURSORS] !== undefined) {
        try {
          const value: unknown = JSON.parse(present[CURSORS]!.toString("utf8"));
          if (!value || typeof value !== "object" || !("v" in value) || !("cursors" in value) || (value.v !== 1 && value.v !== 2) || !value.cursors || typeof value.cursors !== "object" || Array.isArray(value.cursors)) throw new Error("unrecognized cursor sidecar shape");
          for (const [sessionId, raw] of Object.entries(value.cursors as Record<string, unknown>)) {
            let next: unknown; let stream: unknown = null;
            if (value.v === 1) next = raw;
            else if (raw && typeof raw === "object" && !Array.isArray(raw) && "next" in raw) { next = (raw as Record<string, unknown>).next; stream = "stream" in raw ? (raw as Record<string, unknown>).stream : null; }
            if (!sessionId || typeof next !== "number" || !Number.isSafeInteger(next) || next < 1 || (stream !== null && (typeof stream !== "string" || stream.length === 0))) throw new Error(`invalid cursor for ${sessionId}`);
            pendingBounds.push({ sessionId, next, stream: typeof stream === "string" ? stream : null });
          }
        } catch (error) {
          pendingBounds.length = 0;
          refusals.push({ selector: `dsh-bounds:${entry.name}`, category: "bounds", facts: "scan bounds", discarded: `every scan bound of ${entry.name}`, reason: `the cursor sidecar is not structurally valid (${String(error)})`, source });
        }
      }

      // Publish the workflow exactly once, only when some fact actually survived.
      if (identityRows.length || ledgerRows.length || pendingBounds.length) {
        workflows.push({ workflowId: entry.name, identities: identityRows, tailSourceDigest, ledgerRows, scanBounds: pendingBounds });
        if (identityRows.length) findings.push({ source, kind: "identities", count: identityRows.length });
        if (ledgerRows.length) findings.push({ source, kind: "ledgerRows", count: ledgerRows.length });
        if (pendingBounds.length) findings.push({ source, kind: "scanBounds", count: pendingBounds.length });
      }
    }
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }

  // Engine-status envelope: one indivisible unit — bindings and emissions publish
  // together, and only after every binding and bucket validates.
  const bindings: DshHostStateRows["bindings"][number][] = [];
  const emissions: DshHostStateRows["emissions"][number][] = [];
  const snapshotsDir = join(root, SNAPSHOTS);
  try {
    const b = readInside(snapshotsDir, STATUS); allFiles.push([`${SNAPSHOTS}/${STATUS}`, hash(b)]);
    const pendingBindings: DshHostStateRows["bindings"][number][] = [];
    const pendingEmissions: DshHostStateRows["emissions"][number][] = [];
    try {
      const value: unknown = JSON.parse(b.toString("utf8"));
      if (!value || typeof value !== "object" || !("sv" in value) || (value as { sv?: unknown }).sv !== 1 || !("entries" in value) || !(value as { entries?: unknown }).entries || typeof (value as { entries?: unknown }).entries !== "object" || Array.isArray((value as { entries?: unknown }).entries)) throw new Error("unrecognized engine-status envelope schema");
      const buckets = (value as { entries: Record<string, unknown> }).entries;
      // Absent bindings means no picks; a present null (or non-object) map is an
      // invalid legacy authority envelope and refuses the whole status source.
      const declaredBindings = (value as { bindings?: unknown }).bindings;
      if (declaredBindings !== undefined && (declaredBindings === null || typeof declaredBindings !== "object" || Array.isArray(declaredBindings))) throw new Error("invalid engine-status bindings map");
      const source = (declaredBindings ?? {}) as Record<string, unknown>;
      for (const [sessionId, raw] of Object.entries(source)) {
        if (!sessionId || !raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid engine-status binding");
        const binding = raw as Record<string, unknown>;
        if (typeof binding.cwd !== "string" || !binding.cwd || !Number.isSafeInteger(binding.excludedBeforeSeq) || Number(binding.excludedBeforeSeq) < 0) throw new Error("invalid engine-status binding");
        const witness = binding.executionBinding;
        if (witness !== undefined && witness !== null) {
          if (typeof witness !== "object" || Array.isArray(witness) || !("version" in witness) || (witness as { version?: unknown }).version !== 1 || !("session" in witness) || !(witness as { session?: unknown }).session || typeof (witness as { session?: unknown }).session !== "object" || Array.isArray((witness as { session?: unknown }).session)) throw new Error("invalid engine-status execution binding");
          const session = (witness as { session: Record<string, unknown> }).session; const root = (witness as { harnessRoot?: unknown }).harnessRoot;
          if (typeof root !== "string" || !root || typeof session.storeId !== "string" || !session.storeId || typeof session.workflowId !== "string" || !session.workflowId || typeof session.sessionId !== "string" || !session.sessionId || session.role !== "coordinator" || typeof session.epoch !== "number" || !Number.isSafeInteger(session.epoch) || session.epoch <= 0) throw new Error("invalid engine-status execution binding");
        }
        if (binding.selectedWorkflowId !== undefined && (typeof binding.selectedWorkflowId !== "string" || !binding.selectedWorkflowId)) throw new Error("invalid engine-status selected workflow");
        pendingBindings.push({ sessionId, cwd: binding.cwd, selectedWorkflowId: typeof binding.selectedWorkflowId === "string" ? binding.selectedWorkflowId : null, executionBindingJson: witness == null ? null : JSON.stringify(witness), excludedBeforeSeq: Number(binding.excludedBeforeSeq), updatedAt: now });
      }
      for (const [sessionId, bucket] of Object.entries(buckets)) {
        if (!Array.isArray(bucket)) throw new Error("invalid engine-status emission bucket");
        for (const candidate of bucket) {
          if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("invalid engine-status emission");
          const entry = candidate as Record<string, unknown>;
          if (entry.rv !== 1 || typeof entry.cwd !== "string" || !entry.cwd || typeof entry.at !== "string" || !entry.at || typeof entry.turn !== "number" || !Number.isFinite(entry.turn) || !entry.payload || typeof entry.payload !== "object" || Array.isArray(entry.payload)) throw new Error("invalid engine-status emission");
        }
        const newest = bucket.at(-1);
        if (newest === undefined) continue;
        const emission = newest as Record<string, unknown>;
        pendingEmissions.push({ sessionId, cwd: emission.cwd as string, turn: emission.turn as number, emittedAt: emission.at as string, payloadJson: JSON.stringify(emission.payload) });
      }
    } catch (e) {
      pendingBindings.length = 0; pendingEmissions.length = 0;
      refusals.push({ selector: "dsh-status", category: "status", facts: "bindings and emissions", discarded: "every legacy session binding and status emission in the envelope", reason: String(e), source: `${SNAPSHOTS}/${STATUS}` });
    }
    bindings.push(...pendingBindings); emissions.push(...pendingEmissions);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") refusals.push({ selector: "dsh-status", category: "status", facts: "bindings and emissions", discarded: "every legacy session binding and status emission in the envelope", reason: String(e), source: `${SNAPSHOTS}/${STATUS}` });
  }
  // Code-unit order, never the process locale: the digest identity must not change
  // with LC_ALL/LANG or an ICU upgrade, or a same-input retry would falsely conflict.
  const sourceDigest = hash(JSON.stringify(allFiles.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));
  return { rows: { workflows, bindings, emissions }, findings, refusals, sourceDigest };
}

export async function importDshHostStateFiles(input: { context: StoreContext; operator: string; operationId: string; acknowledgedSkips?: readonly string[] }): Promise<DshHostStateImportReport> {
  // The selected generation is captured BEFORE any filesystem evaluation and is
  // required again on the owned transaction handle, so a store replacement or
  // epoch change across the evaluation/await boundary is rejected instead of adopted.
  const selected = withExecutionReadGuard(input.context, (_db, authority) => ({ storeId: authority.storeId, epoch: authority.epoch }));
  const evaluated = evaluate(input.context, new Date().toISOString());
  const acknowledgements = input.acknowledgedSkips ?? [];
  const invalid = acknowledgements.filter((selector) => {
    if (selector === "dsh-status" || selector === "dsh-workflows") return false;
    const match = /^dsh-(?:ledger|bounds):(.+)$/.exec(selector);
    return !match || match[1] === "." || match[1] === ".." || match[1]!.includes("/");
  });
  if (invalid.length) throw new StoreError("store.upgrade-dsh-ack-unmatched", `Invalid --ack-skip-dsh selector ${invalid.join(", ")}; use dsh-status, dsh-workflows, dsh-ledger:<workflowId>, or dsh-bounds:<workflowId>.`);
  const runAt = new Date().toISOString();
  return withExecutionTransaction(input.context, (tx) => {
    if (tx.storeId !== selected.storeId || tx.epoch !== selected.epoch) {
      throw new StoreError("store.stale-epoch", "The selected store identity or epoch changed after legacy host-state evaluation began; nothing was imported. Rerun `mstar store upgrade` against the current store.");
    }
    const requestHash = hash(JSON.stringify({
      operation: "store.upgrade.dsh-host-state",
      root: input.context.harnessDir,
      operator: input.operator,
      sourceDigest: evaluated.sourceDigest,
      acknowledgedSkips: [...acknowledgements].sort(),
    }));
    const prior = tx.db.prepare("select request_hash, result_json from store_operations where operation_id = ?")
      .get(`${input.operationId}#dsh-host-state`) as { request_hash?: unknown; result_json?: unknown } | undefined;
    if (prior) {
      if (prior.request_hash !== requestHash) throw new ExecutionError("execution.operation-conflict", `operationId ${input.operationId} was already used for a different DSH import request.`);
      return JSON.parse(String(prior.result_json)) as DshHostStateImportReport;
    }
    const ackLedgerFact = (refusal: Refusal) => acknowledgements.includes(refusal.selector);
    const allRefusals: Refusal[] = [];
    for (const refusal of evaluated.refusals) if (!ackLedgerFact(refusal)) allRefusals.push(refusal);
    const outcome = importDshHostStateRows({ db: tx.db, storeId: tx.storeId, epoch: tx.epoch }, evaluated.rows, runAt);
    for (const refusal of outcome.refused) if (!ackLedgerFact(refusal)) allRefusals.push(refusal);
    const refusedSelectors = new Set([...evaluated.refusals, ...outcome.refused].map((refusal) => refusal.selector));
    const unmatched = acknowledgements.filter((selector) => !refusedSelectors.has(selector));
    if (unmatched.length) throw new StoreError("store.upgrade-dsh-ack-unmatched", `--ack-skip-dsh selector(s) matched no refused facts in this run: ${unmatched.join(", ")}. Refused selectors: ${[...refusedSelectors].join(", ") || "none"}.`);
    if (allRefusals.length) refused(allRefusals);
    const dropped = [...evaluated.refusals, ...outcome.refused];
    for (const refusal of dropped) {
      evaluated.findings.push({
        source: refusal.source,
        kind: "dropped-by-ack",
        selector: refusal.selector,
        category: refusal.category,
        droppedFacts: refusal.facts,
        droppedScope: refusal.discarded,
        loss: lossStatement(refusal),
      });
    }
    for (const fact of outcome.reusedOrPresent) evaluated.findings.push({ source: "native-store", kind: "reused-or-shadowed", fact });
    const hasWrites = Object.values(outcome.written).some((count) => count > 0) ||
      outcome.merged.scanBoundsAdvanced > 0 || outcome.merged.bindingFloorsRaised > 0;
    const report: DshHostStateImportReport = {
      verdict: dropped.length ? "partially-imported" : hasWrites ? "imported" : "nothing-to-import",
      imported: outcome.written,
      merged: outcome.merged,
      findings: evaluated.findings,
      sourceDigest: evaluated.sourceDigest,
    };
    if (outcome.revisionAdvanced) tx.db.prepare("update store_meta set revision = revision + 1 where id = 1").run();
    tx.db.prepare("insert into store_operations(operation_id, request_hash, result_json, committed_at) values (?, ?, ?, ?)")
      .run(`${input.operationId}#dsh-host-state`, requestHash, JSON.stringify(report), runAt);
    return report;
  });
}
