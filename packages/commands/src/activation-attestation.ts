import {
  ACTIVATION_PROTOCOL_VERSION,
  CONSUMER_KINDS,
  DISPOSITIONS,
  SESSION_STATES,
  readDeclaredNodeFloor,
} from "@mstar-harness/engine";
import { z } from "zod";

/**
 * Descriptive facts from validateActivationAttestation; this is not a
 * validator. The document describes the EXPLICIT `--attestation <path>`
 * override only: when the file is omitted, the consuming verb generates the
 * document from live facts (and a Bun-driven run refuses, because Bun is never
 * an admissible consumer runtime).
 */
export const activationAttestationDocumentConstraints: readonly Readonly<{ path: string; rule: string }>[] = [
  { path: "*", rule: "Every string value must be nonblank (trim() is not empty)." },
  { path: "attestedAt", rule: "Date.parse(value) must be finite; the engine diagnostic calls this an ISO/RFC3339 instant, but validation uses Date.parse semantics." },
  { path: "consumers", rule: "At least one installed consumer is required." },
  { path: "consumers[].runtimeVersion", rule: `Must be "node" and meet the declared floor: node >= ${readDeclaredNodeFloor() ?? "the manifest's engines.node"}. Bun is the development toolchain and is never a consumer runtime.` },
  { path: "consumers[].current", rule: "Exactly one consumer is current, and that consumer's kind must be coordinator." },
  { path: "*", rule: "Only the declared keys at the top level and in operator, consumers[], and stoppedSessions[] are accepted; undeclared credential fields are refused by name." },
  { path: "stoppedSessions[].state", rule: "Only stopped or reloaded sessions are accepted." },
];
/**
 * Structural document contract for the engine-owned validator. Semantic rules
 * which cannot be represented structurally are also published as descriptions.
 */
export const activationAttestationDocumentSchema = z.object({
  version: z.literal(ACTIVATION_PROTOCOL_VERSION),
  attestedAt: z.string(),
  operator: z.object({ actor: z.string(), authorizationRef: z.string() }).strict(),
  consumers: z.array(z.object({
    entryId: z.string(),
    kind: z.enum(Object.keys(CONSUMER_KINDS) as [string, ...string[]]),
    entrypoint: z.string(),
    // A consumer is an installed entrypoint that opens the store, and Bun is this
    // project's development toolchain: the contract has no Bun entry to gate.
    runtime: z.literal("node"),
    runtimeVersion: z.string(),
    version: z.string(),
    current: z.boolean(),
    disposition: z.enum(Object.keys(DISPOSITIONS) as [string, ...string[]]),
  }).strict()).min(1),
  stoppedSessions: z.array(z.object({
    sessionId: z.string(),
    host: z.string(),
    state: z.enum(Object.keys(SESSION_STATES) as [string, ...string[]]),
  }).strict()),
}).strict().describe(activationAttestationDocumentConstraints.map(({ path, rule }) => `${path}: ${rule}`).join(" "));

