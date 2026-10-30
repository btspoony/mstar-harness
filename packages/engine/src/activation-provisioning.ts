/**
 * Automatic attestation provisioning (I-000297): the one document builder the
 * three consuming transactions (`session.recover`, `store.upgrade`,
 * `store.activate`) share. There is no human operator, so a verb that needs an
 * attestation generates it from live facts inside its own transaction; an
 * explicit `--attestation <path>` remains a 1:1 override and is never required.
 *
 * The builder assembles documents only and NEVER validates: each receiving
 * site hands the result to the existing validator
 * (`validateActivationAttestation` / `validateRecoveryAttestation`), which
 * stays the acceptance authority, so a generated document must pass the same
 * rules a hand-authored one always did — by construction.
 *
 * Import note: this module imports the protocol-version constant from
 * `store-activation.js` by value (a plain const, not a function), and
 * `store-activation.ts` imports this module's builders. The cycle is safe
 * because neither module reads the other's bindings during its own module
 * evaluation — every read happens inside a function at call time.
 */
import { readHarnessVersion } from "./core.js";
import { ACTIVATION_PROTOCOL_VERSION, type ActivationAttestation, type StoppedSessionAttestation } from "./store-activation.js";

/**
 * The process facts a consumer row attests, resolved once by the caller.
 * Production call sites use `currentProcessFacts()`; tests inject fixed facts
 * because the Bun test runtime is itself inadmissible as an attested consumer —
 * the activation-scope success path is otherwise unreachable under `bun test`
 * by design, never faked.
 */
export type ProvisionProcessFacts = {
  /** The resolved executing entrypoint (`process.argv[1]`), or absent. */
  entrypoint: string | undefined;
  /** The Node version the executing runtime reports. */
  runtimeVersion: string;
  /** Whether the executing runtime is Bun — never an admissible consumer. */
  isBun: boolean;
};

/** The production process facts: what the running entrypoint actually is. */
export function currentProcessFacts(): ProvisionProcessFacts {
  return {
    entrypoint: process.argv[1],
    runtimeVersion: process.versions.node,
    isBun: process.versions.bun !== undefined,
  };
}

export type ProvisionedActivation =
  | { ok: true; document: ActivationAttestation }
  | { ok: false; cause: "bun-runtime" | "missing-entrypoint"; message: string };

export type ProvisionInput = {
  actor: string;
  authorizationRef: string;
  attestedAt: string;
  stoppedSessions: readonly StoppedSessionAttestation[];
};

/**
 * Build one ACTIVATION-scope document: a single current-coordinator consumer
 * row derived from the executing process facts, or a named refusal when a fact
 * cannot be established. No fact is ever invented: Bun cannot attest a Node
 * consumer row, and an entrypoint-less process cannot name what it attests.
 */
export function provisionActivationDocument(input: ProvisionInput, facts: ProvisionProcessFacts = currentProcessFacts()): ProvisionedActivation {
  if (facts.isBun) {
    return {
      ok: false,
      cause: "bun-runtime",
      message:
        "the running process is Bun, which is never an admissible consumer runtime, so a Node consumer row cannot be attested",
    };
  }
  if (facts.entrypoint === undefined || facts.entrypoint.trim() === "") {
    return {
      ok: false,
      cause: "missing-entrypoint",
      message: "the executing entrypoint is not identifiable (`process.argv[1]` is absent)",
    };
  }
  return {
    ok: true,
    document: {
      version: ACTIVATION_PROTOCOL_VERSION,
      attestedAt: input.attestedAt,
      operator: { actor: input.actor, authorizationRef: input.authorizationRef },
      consumers: [
        {
          // The narrow attestation this is: the EXECUTING consumer only, not
          // an inventory of every installed host plugin or shell integration.
          entryId: basename(facts.entrypoint),
          kind: "coordinator",
          entrypoint: facts.entrypoint,
          runtime: "node",
          runtimeVersion: facts.runtimeVersion,
          version: readHarnessVersion(),
          current: true,
          disposition: "reloaded",
        },
      ],
      stoppedSessions: [...input.stoppedSessions],
    },
  };
}

/**
 * Build one RECOVERY-scope document (`consumers: []`, which the recovery
 * validator accepts and ignores): the store is already active, so the
 * installed-consumer obligation of the activation barrier does not apply.
 * The operator authorization and the attested stops are the whole document,
 * and every input here is a recorded transaction fact, so this cannot fail.
 */
export function provisionRecoveryDocument(input: ProvisionInput): ActivationAttestation {
  return {
    version: ACTIVATION_PROTOCOL_VERSION,
    attestedAt: input.attestedAt,
    operator: { actor: input.actor, authorizationRef: input.authorizationRef },
    consumers: [],
    stoppedSessions: [...input.stoppedSessions],
  };
}

/** The entrypoint's own file name: the consumer row's `entryId`. */
function basename(entrypoint: string): string {
  const normalized = entrypoint.replaceAll("\\", "/");
  const last = normalized.lastIndexOf("/");
  return last === -1 ? normalized : normalized.slice(last + 1);
}
