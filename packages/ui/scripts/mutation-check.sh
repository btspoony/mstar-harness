#!/usr/bin/env bash
# Prove every check can fail.
#
# A check that has never been seen to fail is a check nobody knows the coverage of. This
# project found that the hard way: `check:declarations` printed "193 shared selectors inside a
# breakpoint block" while comparing none of them, and `check:classes` matched class names as
# substrings, so renaming `.res-grid` to `.res-gridZZ` passed.
#
# Each case below breaks something on purpose, runs the check, and requires a non-zero exit.
# The restore runs from a trap, so a failure mid-suite cannot leave a mutated file behind.
#
# Exit codes are read directly rather than through a pipe: `cmd | tail; echo $?` reports
# tail's status, which is always success. Two of the original hand-run experiments were wrong
# for exactly that reason.
#
# Usage: packages/ui/scripts/mutation-check.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"
BACKUP="$(mktemp -d)"
trap 'rm -rf "$BACKUP"; for f in packages/ui/src/styles/product.css packages/ui/src/styles/base.css packages/ui/scripts/selector-diff.ts; do [ -f "$BACKUP/$(basename "$f")" ] && cp "$BACKUP/$(basename "$f")" "$f"; done' EXIT

save() { cp "$1" "$BACKUP/$(basename "$1")"; }
restore_all() {
  for f in packages/ui/src/styles/product.css packages/ui/src/styles/base.css packages/ui/scripts/selector-diff.ts; do
    [ -f "$BACKUP/$(basename "$f")" ] && cp "$BACKUP/$(basename "$f")" "$f"
  done
}

FAIL=0
expect_fail() {
  local name="$1"; local check="$2"
  local out; out="$(bun run --cwd packages/ui "check:$check" 2>&1)"; local code=$?
  if [ "$code" -eq 0 ]; then
    echo "FAIL ${name}: check:${check} passed with the defect in place" >&2
    FAIL=1
  else
    echo "ok   ${name}: check:${check} reported it"
  fi
}

save packages/ui/src/styles/product.css
save packages/ui/src/styles/base.css
save packages/ui/scripts/selector-diff.ts

# --- 1. a class name the sheets do not define. Every occurrence, in every sheet, because a
#        prefix-only rename still contains the original as a substring.
sed -i.bak 's/res-grid/res-gridZZ/g' packages/ui/src/styles/product.css packages/ui/src/styles/base.css
expect_fail "an undefined class" classes
restore_all

# --- 2. a breakpoint declaration that disagrees with the prototype's.
python3 - <<'PY'
import io, re
p = "packages/ui/src/styles/product.css"
t = io.open(p, encoding="utf-8").read()
old = ".ms-container .screen-meta { flex-wrap: nowrap; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }"
assert t.count(old) == 1, "the 479 rule moved"
io.open(p, "w", encoding="utf-8").write(t.replace(old, old.replace("nowrap", "wrap", 1), 1))
PY
expect_fail "a breakpoint declaration" declarations
restore_all

# --- 3. a prototype surface that is neither defined nor explained.
python3 - <<'PY'
import io
p = "packages/ui/scripts/selector-diff.ts"
t = io.open(p, encoding="utf-8").read()
old = '  { match: (s) => s.startsWith(".proto-"), why: "the design document\'s own screen switcher" },\n'
assert t.count(old) == 1, "the allowlist entry moved"
io.open(p, "w", encoding="utf-8").write(t.replace(old, "", 1))
PY
expect_fail "an unexplained prototype surface" selectors
restore_all

# --- 4. a stale compiled bundle: touch a source file the bundle is built from.
touch packages/cli/web/main.tsx
expect_fail "a stale bundle" stale
restore_all

rm -f packages/ui/src/styles/*.bak
if [ "$FAIL" -ne 0 ]; then
  echo "mutation check failed: a check did not notice its defect" >&2
  exit 1
fi
echo "every check notices a defect of its own kind"
