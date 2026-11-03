/**
 * The shipped `bundle/cordis.patch.yml`, read in the dsh loader's own YAML
 * dialect: `!!js` scalars stay expression nodes (`{ __jsExpr }`), exactly as
 * `@deepseek-ai/cordis-plugin-include`'s `entryListSchema` produces them. Both
 * the bundle-layer contract test and the Linear credential fixtures read the
 * one file through this, so neither can drift from what the Loader parses.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { JSON_SCHEMA, NOT_RESOLVED, defineScalarTag, load, type Schema } from 'js-yaml'

/** The bundle's patch file path exactly as `loadProfile` resolves it. */
export const PATCH_PATH = join(import.meta.dir, '..', 'bundle', 'cordis.patch.yml')

const JS_EXPR_TAG = defineScalarTag<{ __jsExpr: string }>('tag:yaml.org,2002:js', {
  resolve: (source, isExplicit) => (isExplicit ? { __jsExpr: source } : NOT_RESOLVED),
  identify: (data) => typeof data === 'object' && data !== null && '__jsExpr' in data,
})

const ENTRY_LIST_SCHEMA: Schema = JSON_SCHEMA.withTags(JS_EXPR_TAG)

/** Row shape of a cordis entry list (the dsh-bundle patch row contract). */
export interface EntryRow {
  id?: string
  name?: string
  config?: Record<string, unknown>
  disabled?: boolean | null
  inject?: string[]
}

/** One patch op: `- insert:` lists or an id-targeted override. */
export interface PatchOp {
  id?: string
  insert?: EntryRow[]
  config?: Record<string, unknown>
}

/** Parse the shipped patch file as a patch-op list (throws when it is not one). */
export function readBundlePatch(): PatchOp[] {
  const parsed = load(readFileSync(PATCH_PATH, 'utf8'), { schema: ENTRY_LIST_SCHEMA })
  if (!Array.isArray(parsed)) throw new Error(`${PATCH_PATH} is not a patch list`)
  return parsed as PatchOp[]
}
