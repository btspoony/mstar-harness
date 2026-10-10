/** Public field contract for the `mstar.review/v1` envelope. */
export const MSTAR_REVIEW_V1_PAYLOAD_SCHEMA = {
  schema: { required: true, type: "string", description: "Must be mstar.review/v1." },
  verdict: { required: true, type: "string", description: "Harness PR verdict." },
  summary_md: { required: true, type: "string", description: "Review summary in Markdown." },
  findings: { required: true, type: "array", description: "Review findings with harness merge-class vocabulary." },
  tally: { required: false, type: "object", description: "Optional computed tally; when present, full shape and verdict consistency are validated; optional band: mergeable | good | pass | fail (absent = legacy-valid)." },
  target: { required: false, type: "object", description: "Optional target identity." },
} as const;
