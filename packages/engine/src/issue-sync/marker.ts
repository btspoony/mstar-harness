/** The three fields the marker carries. `author` is `"Name <email>"` as git reports it. */
export type MarkerFields = { repo: string; localId: string; author: string };

const MARKER_PATTERN = /<!--\s*mstar-sync:\s*([^\n]*?)\s*-->/g;

/**
 * The marker a payload description ends with.
 *
 * shortcut: the fields are written and split verbatim, so a value containing
 * `-->` truncates the marker, and a value containing `;` or `=` mis-splits
 * the key/value pairs - an identity carrying any of them decodes wrong or not
 * at all, and the record reads as unmanaged; the recovery is `issue-sync apply
 * --adopt`. No escaping: the format is frozen. upgrade: escape the fields when
 * such an identity ever appears in git config.
 */
export function encodeMarker(fields: MarkerFields): string {
  return "<!-- mstar-sync: repo=" + fields.repo + "; local=" + fields.localId + "; author=" + fields.author + " -->";
}

/**
 * The marker one description carries, or null when it carries none.
 *
 * A marker without `repo` or `local` is not a marker of this format: the
 * deleted code's `workspace/team/storeId/localId` payload decodes to null, which
 * is what makes a record pushed by that code `unmanaged` rather than silently
 * associated with the wrong issue.
 */
export function decodeMarker(description: string | null | undefined): MarkerFields | null {
  const raw = lastMarkerPayload(description);
  if (raw === null) return null;
  const fields: Record<string, string> = {};
  for (const part of raw.split(";")) {
    const at = part.indexOf("=");
    if (at === -1) continue;
    fields[part.slice(0, at).trim().toLowerCase()] = part.slice(at + 1).trim();
  }
  const repo = fields.repo ?? "";
  const localId = fields.local ?? "";
  if (repo === "" || localId === "") return null;
  return { repo, localId, author: fields.author ?? "" };
}

/** note: The payload of the LAST marker in the text, or null when it carries none. */
function lastMarkerPayload(description: string | null | undefined): string | null {
  if (typeof description !== "string") return null;
  let last: string | null = null;
  for (const match of description.matchAll(MARKER_PATTERN)) {
    last = match[1]!.trim();
  }
  return last;
}
