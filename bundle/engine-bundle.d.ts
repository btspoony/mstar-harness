/**
 * Type declarations for the committed host-neutral engine bundle
 * (`bundle/engine-bundle.js`, built by `bun run engine:bundle`).
 *
 * The bundle mirrors the engine's public surface exactly, so the
 * declarations re-export the engine's built declarations rather than
 * duplicating signatures. Type-only: erased at load time, never shipped
 * into the runtime artifact.
 */
export * from "../packages/engine/dist/index.js";
