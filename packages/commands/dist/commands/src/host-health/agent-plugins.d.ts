/**
 * Agent Plugins v1.0.0 conformance validator (https://agent-plugins.org/specification).
 *
 * Implements the closed plugin.json manifest schema (§5), mcp.json component
 * configuration (§7.2.1), and skills discovery (§6.1/§7.1) without any runtime
 * schema fetching. All validation rules are implemented locally in TS.
 *
 * Severity model:
 * - `errors` — findings that make the package non-conformant (missing/invalid
 *   manifest, `$schema`, `name`, or metadata types; mcp.json violations). Each
 *   line carries a `plugin.json:` / `mcp.json:` / `skills:` prefix.
 * - `warnings` — report-and-ignore findings that do not fail validation:
 *   unknown top-level plugin.json fields are reported and ignored while the
 *   plugin keeps loading (§5.2), non-object `extensions` fields and namespace
 *   entries are reported and ignored without validating their contents
 *   (§5.2/§8.1), and non-conforming skills are skipped while other skills and
 *   component types keep loading (§7.1). A child directory under skills/
 *   without SKILL.md is simply not a skill.
 *
 * Validation continues past report-and-ignore findings so one run aggregates
 * every issue; `ok` is false when any error was recorded.
 */
export type AgentPluginValidation = {
    ok: boolean;
    errors: string[];
    warnings: string[];
};
export declare function validateAgentPlugin(root: string): AgentPluginValidation;
