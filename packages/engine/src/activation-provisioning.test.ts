/**
 * The activation-provisioning builder (I-000297): document assembly only, no
 * validation. These tests pin the named refusals (Bun runtime, missing
 * entrypoint), the single current-coordinator consumer row derived from
 * injected process facts, and the recovery-scope document's consumer-free
 * shape — the validator stays the acceptance authority at each receiving site
 * and is deliberately not restated here.
 */
import { describe, expect, test } from "bun:test";
import { readHarnessVersion } from "./core.js";
import { provisionActivationDocument, provisionRecoveryDocument } from "./activation-provisioning.js";
import { ACTIVATION_PROTOCOL_VERSION, validateActivationAttestation, validateRecoveryAttestation } from "./store-activation.js";
import { readDeclaredNodeFloor } from "./core.js";

const FACTS = {
  entrypoint: "/opt/mstar/cli/dist/mstar-harness.js",
  // At or above the declared floor: the validator compares the injected
  // runtime version against the manifest's own `engines.node`.
  runtimeVersion: `${Number.parseInt((readDeclaredNodeFloor() ?? "0.0.0").split(".")[0]!, 10) + 1}.0.0`,
  isBun: false,
};
const INPUT = {
  actor: "ops-engineer",
  authorizationRef: "migration-receipt:41",
  attestedAt: "2026-10-30T00:00:00.000Z",
  stoppedSessions: [{ sessionId: "sess-old", host: "local", state: "stopped" as const }],
};

describe("provisionActivationDocument", () => {
  test("derives one current coordinator consumer row from the injected process facts", () => {
    const provisioned = provisionActivationDocument(INPUT, FACTS);
    if (!provisioned.ok) throw new Error(`unexpected refusal: ${provisioned.message}`);
    const { document } = provisioned;
    expect(document.version).toBe(ACTIVATION_PROTOCOL_VERSION);
    expect(document.operator).toEqual({ actor: "ops-engineer", authorizationRef: "migration-receipt:41" });
    expect(document.consumers).toEqual([
      {
        entryId: "mstar-harness.js",
        kind: "coordinator",
        entrypoint: FACTS.entrypoint,
        runtime: "node",
        runtimeVersion: FACTS.runtimeVersion,
        // The installed version is the owning manifest's, never pinned here.
        version: readHarnessVersion(),
        current: true,
        disposition: "reloaded",
      },
    ]);
    expect(document.stoppedSessions).toEqual(INPUT.stoppedSessions);
    // By construction the generated document passes the acceptance authority.
    expect(() => validateActivationAttestation(document)).not.toThrow();
  });

  test("refuses a Bun runtime with the named cause and message", () => {
    const provisioned = provisionActivationDocument(INPUT, { ...FACTS, isBun: true });
    expect(provisioned).toMatchObject({
      ok: false,
      cause: "bun-runtime",
      message: "the running process is Bun, which is never an admissible consumer runtime, so a Node consumer row cannot be attested",
    });
  });

  test("refuses an unidentifiable entrypoint with the named cause and message", () => {
    const provisioned = provisionActivationDocument(INPUT, { ...FACTS, entrypoint: undefined });
    expect(provisioned).toMatchObject({
      ok: false,
      cause: "missing-entrypoint",
      message: "the executing entrypoint is not identifiable (`process.argv[1]` is absent)",
    });
  });

  test("refuses an unestablishable installed version instead of fabricating 0.0.0", () => {
    // The consumer row's version is durable evidence (it lands in a receipt), so
    // a missing owning manifest refuses rather than inventing the historical
    // "0.0.0" display fallback: every other unestablishable fact refuses too.
    const provisioned = provisionActivationDocument(INPUT, { ...FACTS, harnessVersion: null });
    expect(provisioned).toMatchObject({
      ok: false,
      cause: "missing-manifest",
      message: "no visible manifest declares the installed harness version (`packages/*/package.json` or the repo root), so the consumer row's version cannot be attested",
    });
    // An explicit resolved version (the test seam) keeps the success path and is
    // recorded verbatim — never the fabricated default.
    const resolved = provisionActivationDocument(INPUT, { ...FACTS, harnessVersion: "0.0.0-synthetic" });
    if (!resolved.ok) throw new Error(`unexpected refusal: ${resolved.message}`);
    expect(resolved.document.consumers[0]?.version).toBe("0.0.0-synthetic");
  });
});

describe("provisionRecoveryDocument", () => {
  test("builds the consumer-free operator document and cannot fail", () => {
    const document = provisionRecoveryDocument(INPUT);
    expect(document).toEqual({
      version: ACTIVATION_PROTOCOL_VERSION,
      attestedAt: INPUT.attestedAt,
      operator: { actor: "ops-engineer", authorizationRef: "migration-receipt:41" },
      consumers: [],
      stoppedSessions: INPUT.stoppedSessions,
    });
    // The recovery validator accepts the empty consumer list (it ignores it).
    expect(() => validateRecoveryAttestation(document)).not.toThrow();
  });
});
