/**
 * Native omp plugin-settings reader for the iteration model handoff.
 *
 * The saved preference is read through the exported host helper
 * (`getPluginSettings`) on every call. That helper rereads the user runtime
 * settings plus the project `plugin-overrides.json`, while a long-lived
 * `PluginManager` keeps the snapshot it loaded first — so entry-time and
 * fire-time reads both observe a settings edit made during the same session.
 *
 * Keys absent from the effective settings fall back to the manifest defaults
 * (`false`, `@default`) per key. A key that is present but not one of the
 * values declared in `omp.settings` refuses the action with a visible reason
 * instead of being coerced: a wrong `handoffTarget` must never silently pick a
 * different model role than the one the user saved.
 */
import { getPluginSettings } from "@oh-my-pi/pi-coding-agent/extensibility/plugins";

/** npm package whose native settings own this feature (manifest `omp.settings`). */
const PLUGIN_NAME = "@mstar-harness/omp";

/** Model role this coordinator session is switched to after a completed Phase 1. */
export type HandoffTarget = "@default" | "@smol";

export type HandoffSettings = Readonly<{
  modelHandoff: boolean;
  handoffTarget: HandoffTarget;
}>;

export type HandoffSettingsResult =
  | { ok: true; value: HandoffSettings }
  | { ok: false; reason: "settings-read-failed" | "invalid-settings"; message: string };

/** Manifest `values` for `handoffTarget`, in manifest order. */
const HANDOFF_TARGETS: readonly HandoffTarget[] = ["@default", "@smol"];

/** Manifest defaults, applied per key and only when that key is absent. */
const DEFAULT_MODEL_HANDOFF = false;
const DEFAULT_HANDOFF_TARGET: HandoffTarget = "@default";

/** One refusal message per malformed key, so every rejection reads the same way. */
function invalidValue(key: string, requirement: string, value: unknown): HandoffSettingsResult {
  return {
    ok: false,
    reason: "invalid-settings",
    message: `${key} must be ${requirement}, received ${typeof value === "string" ? JSON.stringify(value) : String(value)}`,
  };
}

function isHandoffTarget(value: unknown): value is HandoffTarget {
  return typeof value === "string" && (HANDOFF_TARGETS as readonly string[]).includes(value);
}

/**
 * Decode the effective `@mstar-harness/omp` settings record into the handoff
 * preference. Pure: `readHandoffSettings` adds only the host read.
 */
export function decodeHandoffSettings(raw: Record<string, unknown>): HandoffSettingsResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return invalidValue("plugin settings", "an object", raw);
  }

  const modelHandoff = raw.modelHandoff === undefined ? DEFAULT_MODEL_HANDOFF : raw.modelHandoff;
  if (typeof modelHandoff !== "boolean") {
    return invalidValue("modelHandoff", "a boolean", raw.modelHandoff);
  }

  const handoffTarget = raw.handoffTarget === undefined ? DEFAULT_HANDOFF_TARGET : raw.handoffTarget;
  if (!isHandoffTarget(handoffTarget)) {
    return invalidValue("handoffTarget", `one of ${HANDOFF_TARGETS.join(" | ")}`, raw.handoffTarget);
  }

  return { ok: true, value: { modelHandoff, handoffTarget } };
}

/**
 * Read the effective native handoff preference for a coordinator session
 * running in `cwd`. Never throws: refusal and read failure are both reported
 * through `HandoffSettingsResult` so the caller can surface them.
 */
export async function readHandoffSettings(cwd: string): Promise<HandoffSettingsResult> {
  let raw: Record<string, unknown>;
  try {
    raw = await getPluginSettings(PLUGIN_NAME, cwd);
  } catch (error) {
    return {
      ok: false,
      reason: "settings-read-failed",
      message: `could not read ${PLUGIN_NAME} plugin settings: ${String(error)}`,
    };
  }

  return decodeHandoffSettings(raw);
}
