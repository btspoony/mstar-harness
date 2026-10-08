import {
  ACTIVATION_PROTOCOL_VERSION,
  CONSUMER_KINDS,
  DISPOSITIONS,
  MIN_BUN_VERSION,
  MIN_NODE_VERSION,
  SESSION_STATES,
} from "@mstar-harness/engine";
import { z } from "zod";

/** Descriptive facts from validateActivationAttestation; this is not a validator. */
export const activationAttestationDocumentConstraints: readonly Readonly<{ path: string; rule: string }>[] = [
  { path: "*", rule: "Every string value must be nonblank (trim() is not empty)." },
  { path: "attestedAt", rule: "Date.parse(value) must be finite; the engine diagnostic calls this an ISO/RFC3339 instant, but validation uses Date.parse semantics." },
  { path: "consumers", rule: "At least one installed consumer is required." },
  { path: "consumers[].runtimeVersion", rule: `Must meet the declared runtime floor: bun >= ${MIN_BUN_VERSION}; node >= ${MIN_NODE_VERSION}.` },
  { path: "consumers[].current", rule: "Exactly one consumer is current, and that consumer's kind must be coordinator." },
  { path: "*", rule: "Only the declared keys at the top level and in operator, consumers[], and stoppedSessions[] are accepted; undeclared credential fields are refused by name." },
  { path: "stoppedSessions[].state", rule: "Only stopped or reloaded sessions are accepted." },
];
/**
 * Structural document contract for the engine-owned validator. Semantic rules
 * which cannot be represented by this transport schema are published below.
 */
export const activationAttestationDocumentSchema = z.object({
  version: z.literal(ACTIVATION_PROTOCOL_VERSION),
  attestedAt: z.string(),
  operator: z.object({ actor: z.string(), authorizationRef: z.string() }).strict(),
  consumers: z.array(z.object({
    entryId: z.string(),
    kind: z.enum(Object.keys(CONSUMER_KINDS) as [string, ...string[]]),
    entrypoint: z.string(),
    runtime: z.enum(["bun", "node"]),
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

