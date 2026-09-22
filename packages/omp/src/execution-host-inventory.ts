/**
 * Execution host inventory — the §4.2 bounded evidence wrapper for one native
 * session's OMP hidden history.
 *
 * Primary spec: architecture contract §4.2 ("Host hidden result") and §4.1's
 * `omp-hidden-entries` row. The engine cannot inspect a live host process, so a
 * producer running INSIDE the carrying native session supplies the bounded
 * evidence: the ordered entry IDs/types/payload digests of that session's hidden
 * ledger plus the native session identity, in one canonical document.
 *
 * Exactly one export covers exactly one native session
 * (`ctx.sessionManager.getSessionId()`), and the session reads only its OWN
 * ledger. Aggregation belongs to C3: it aligns the explicitly named session set
 * of one workflow against one evidence document per named session and checks the
 * operator's existing `ActivationAttestation` separately. This module therefore:
 *
 * - never claims quiesced/complete coverage, never declares stop/adoption state
 *   and never manufactures an operator attestation;
 * - never discovers session files: the entries arrive from the host session
 *   manager (the caller), never from a home/state directory scan;
 * - never binds, adopts, spawns, mutates engine state or grants authority. It
 *   produces evidence bytes and nothing else — a carrying leaf may export its
 *   own readable history without gaining any coordinator authority.
 *
 * The document embeds H1's own export value (`ExecutionHostHistory`) verbatim,
 * because that value already carries the ordered record IDs, types and payload
 * digests: a parallel summary would be a second, drift-prone copy of the same
 * facts, so there is none. What the wrapper adds is the binding of those bytes
 * to ONE workflow and ONE native session, plus the digest of the exact export
 * bytes, so a consumer can recompute both instead of trusting a summary:
 *
 *     {version:1, protocol:"host-hidden-inventory-v1", workflowId, host:"omp",
 *      hostSessionId, export:{sha256, document:ExecutionHostHistory}}
 *
 * - `export.sha256` is the sha256 of the exact UTF-8 bytes
 *   `exportExecutionHostHistory(document)` returns — H1's canonical form (sorted
 *   keys, no whitespace, one terminal LF). No further LF is appended: the digest
 *   names those bytes, not a file encoding of them.
 * - the serialized envelope is `serializeExecutionValue(envelope)`, which is the
 *   same canonical form with its own single terminal LF.
 *
 * Refusals are fail-closed and produce no document at all:
 *
 * - a blank native session id or workflow id (the identity is host-derived, and
 *   an absent one is never synthesized);
 * - H1's own export refusal (`ExecutionHostHistoryExportRefusal`): at least one
 *   retained payload is not admissible to the canonical form, so the evidence
 *   cannot be written canonically;
 * - a **decoded** record that declares another workflow: §4.1 requires the
 *   identities declared inside the source bytes to match the assigned workflow,
 *   and history is never filtered to hide the mismatch. Unverifiable raw
 *   payloads are retained exactly as H1 returns them (its own diagnosis policy);
 *   they are not upgraded into verified coverage here.
 */
import { createHash } from "node:crypto";
import { serializeExecutionValue } from "@mstar-harness/engine";
import {
  exportExecutionHostHistory,
  readExecutionHostHistory,
  type ExecutionHostHistory,
} from "./execution-history";

/** The one protocol string this document declares. */
export const HOST_INVENTORY_PROTOCOL = "host-hidden-inventory-v1";
/** The host this producer belongs to (the document's own `host` field). */
export const HOST_INVENTORY_HOST = "omp";
/** The only schema generation this producer writes. */
export const HOST_INVENTORY_VERSION = 1;

/**
 * The §4.2 document: one native session's hidden-history export, bound to the
 * workflow it is assigned to. Evidence only — it carries no credential, no
 * session reference and no authority.
 */
export type ExecutionHostInventory = Readonly<{
  version: typeof HOST_INVENTORY_VERSION;
  protocol: typeof HOST_INVENTORY_PROTOCOL;
  workflowId: string;
  host: typeof HOST_INVENTORY_HOST;
  hostSessionId: string;
  export: Readonly<{ sha256: string; document: ExecutionHostHistory }>;
}>;

/**
 * Raised when a bounded inventory cannot be produced. The message names the
 * refusal so a caller can surface it verbatim; nothing partial is returned.
 */
export class ExecutionHostInventoryRefusal extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ExecutionHostInventoryRefusal";
    this.code = code;
  }
}

function refuse(code: string, message: string): never {
  throw new ExecutionHostInventoryRefusal(code, message);
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * The digest of one exported history value: sha256 over the canonical bytes
 * `exportExecutionHostHistory` returns **excluding the single terminal LF**.
 *
 * That is the repository's house rule for a ledger body's identity — the
 * append-only identity index defines a row as the sha256 of the "exact ledger
 * line bytes excluding the final LF" — and canonical contract §4.2 now states
 * it as the one rule for `export.sha256`: the serialized document's terminal LF
 * is framing, and the ENVELOPE's own LF is not part of this digest either. The
 * slice is exactly one byte (canonical serialization always emits exactly one
 * terminal LF), never a trim of arbitrary trailing whitespace, so a body that
 * legitimately ends in `\n` inside a string keeps its bytes.
 *
 * Exported so a consumer's recomputation and this producer's digest use one rule.
 */
export function historyExportDigest(document: ExecutionHostHistory): string {
  const canonical = exportExecutionHostHistory(document);
  return createHash("sha256").update(canonical.slice(0, -1), "utf8").digest("hex");
}

/**
 * Build the bounded inventory of ONE carrying native session.
 *
 * `entries` are that session's own ledger entries exactly as the host exposes
 * them; this module never reads a session file itself. A decoded record that
 * declares a workflow other than `workflowId` refuses the whole document — the
 * history is never filtered or relabelled to make it fit.
 */
export function buildExecutionHostInventory(input: {
  workflowId: string;
  hostSessionId: string;
  entries: readonly unknown[];
}): ExecutionHostInventory {
  if (!isNonEmpty(input?.workflowId)) {
    refuse("inventory.workflow-missing", "a host inventory needs the non-empty workflow id it is assigned to");
  }
  if (!isNonEmpty(input?.hostSessionId)) {
    refuse(
      "inventory.session-missing",
      "this host session has no native session id, so no inventory can be attributed to it — the identity is never synthesized",
    );
  }
  const entries = Array.isArray(input.entries) ? input.entries : refuse("inventory.entries-missing", "a host inventory needs the session's own ledger entries");

  const document = readExecutionHostHistory(entries);
  // §4.1: identities declared inside the source bytes must match the assigned
  // workflow. Only a record that actually declares one can be compared; an
  // undecoded/undeclared payload stays retained as H1 returned it.
  for (const record of document.records) {
    const declared = record.view?.workflowId;
    if (declared !== undefined && declared !== input.workflowId) {
      refuse(
        "inventory.workflow-mismatch",
        `entry ${record.entryId ?? `#${record.index}`} (${record.type}) declares workflow ${JSON.stringify(declared)}, not the assigned ${JSON.stringify(input.workflowId)}; the history is kept whole, never filtered to fit the assignment`,
      );
    }
  }

  let sha256: string;
  try {
    sha256 = historyExportDigest(document);
  } catch (error) {
    if (error instanceof Error && error.name === "ExecutionHostHistoryExportRefusal") {
      refuse("inventory.export-refused", error.message);
    }
    throw error;
  }

  return {
    version: HOST_INVENTORY_VERSION,
    protocol: HOST_INVENTORY_PROTOCOL,
    workflowId: input.workflowId,
    host: HOST_INVENTORY_HOST,
    hostSessionId: input.hostSessionId,
    export: { sha256, document },
  };
}

/**
 * The exact bytes of one inventory: the engine's canonical form with its single
 * terminal LF. A caller (the coordinator) saves these bytes at an explicit
 * evidence path through the existing file-write channel; this module opens no
 * file and knows no path.
 */
export function exportExecutionHostInventory(inventory: ExecutionHostInventory): string {
  return serializeExecutionValue(inventory);
}

/**
 * sha256 of the exact canonical envelope bytes as delivered — the evidence
 * witness digest, framing LF included (that byte is part of the FILE this
 * producer hands over, unlike the terminal LF of the embedded export, which the
 * §4.2 rule excludes from `export.sha256`).
 */
export function inventoryDigest(inventory: ExecutionHostInventory): string {
  return createHash("sha256").update(exportExecutionHostInventory(inventory), "utf8").digest("hex");
}
