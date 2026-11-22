/**
 * note: The strict JSON document shapes the remote/outbox `--input` flags carry, published
 * as `payloadSchemas.inputDocument` by `mstar schema --command <id>` and named by the option
 * help. The ONE owner of these shapes is the engine (`remote-documents` in
 * `@mstar-harness/engine`): this module only re-exports the engine-owned schemas, so the
 * published descriptors can never drift from the document the engine's runtime parsers
 * enforce. The engine's DTO validators stay the runtime authority, and nothing here
 * enforces what only the engine can judge (frozen-event equality, capability proof, scope
 * freshness, a semantic key's quality, portable-text fidelity).
 */
export {
  remoteAdoptionDocumentSchema,
  remoteBindDocumentSchema,
  remoteForkObservationDocumentSchema,
  remoteObserveDocumentSchema,
  remoteReceiptDocumentSchema,
  remoteReconcileDocumentSchema,
  remoteResolutionDocumentSchema,
} from "@mstar-harness/engine";
