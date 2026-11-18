#!/usr/bin/env bash
# why: the comment gate's file selection is one shipped pipeline, so CI and its
# test run the same steps - dropping a NUL-safety step then fails the test
# instead of leaving a green suite that guards nothing.
# invariant: NUL-terminated end to end (git's -z, printf '%s\0'); the caller
# consumes the stream with xargs -0, so a path holding a space or a newline
# stays one record. usage: comment-gate-select.sh <base-ref>.
set -euo pipefail
base="${1:?usage: comment-gate-select.sh <base-ref>}"
git diff --name-only -z --diff-filter=ACMR "$base" -- packages scripts \
  | while IFS= read -r -d '' path; do
      case "$path" in
        *.ts|*.tsx|*.mts|*.cts|*.js|*.jsx|*.mjs|*.cjs|*.py|*.go|*.rs|*.sh|*.bash|*.zsh|*.rb|*.java|*.kt|*.swift) printf '%s\0' "$path" ;;
      esac
    done
