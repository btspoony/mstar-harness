#!/usr/bin/env bash
# Read-only rollup of open residual_findings into tech_debt_summary aggregates.
# Does not write status.json — PM applies output manually.
set -euo pipefail

STATUS_FILE="${1:-.agents/status.json}"

if [[ ! -f "$STATUS_FILE" ]]; then
  echo "error: status file not found: $STATUS_FILE" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "error: jq is required" >&2
  exit 1
fi

# Merge canonical + legacy maps (canonical keys win). Legacy "warning" -> low.
# Skip entries with lifecycle != open (default open when omitted).
read -r -d '' JQ_FILTER <<'JQEOF' || true
def norm_sev:
  if . == "warning" then "low"
  elif . == null or . == "" then "medium"
  else .
  end;

def is_open:
  (.lifecycle // "open") == "open";

(.residual_findings // {}) as $canon
| (.metadata.residual_findings // {}) as $legacy
| ($canon + $legacy) as $merged
| [
    $merged
    | to_entries[]
    | .key as $plan
    | .value[]
    | select(is_open)
    | . + { _plan_id: $plan }
  ] as $items
| {
    total_open: ($items | length),
    by_severity: (
      ["critical", "high", "medium", "low", "nit"]
      | map(. as $s
        | { ($s): ([$items[] | select((.severity | norm_sev) == $s)] | length) })
      | add
    ),
    by_target: (
      $items
      | map(.target // "unspecified")
      | group_by(.)
      | map({ key: .[0], value: length })
      | from_entries
    ),
    by_plan: (
      $items
      | group_by(._plan_id)
      | map({ key: .[0]._plan_id, value: length })
      | from_entries
    )
  }
JQEOF

COMPUTED=$(jq -c "$JQ_FILTER" "$STATUS_FILE")
STORED=$(jq -c '.metadata.tech_debt_summary // null' "$STATUS_FILE")

echo "=== tech_debt_summary (computed from open residual_findings) ==="
echo "$COMPUTED" | jq '.'

echo ""
echo "=== stored metadata.tech_debt_summary ==="
if [[ "$STORED" == "null" ]]; then
  echo "(none)"
else
  echo "$STORED" | jq '.'
fi

echo ""
echo "=== consistency check ==="

compare_field() {
  local field="$1"
  local computed stored
  computed=$(echo "$COMPUTED" | jq -c ".$field")
  if [[ "$STORED" == "null" ]]; then
    echo "DRIFT: no stored tech_debt_summary (computed $field = $computed)"
    return 1
  fi
  stored=$(echo "$STORED" | jq -c ".$field // null")
  if [[ "$computed" == "$stored" ]]; then
    echo "PASS: $field"
    return 0
  fi
  echo "DRIFT: $field"
  echo "  computed: $computed"
  echo "  stored:   $stored"
  return 1
}

FAIL=0
compare_field total_open || FAIL=1
compare_field by_severity || FAIL=1
compare_field by_target || FAIL=1
compare_field by_plan || FAIL=1

if [[ "$FAIL" -eq 0 ]]; then
  echo ""
  echo "OVERALL: PASS"
  exit 0
fi

echo ""
echo "OVERALL: DRIFT — refresh metadata.tech_debt_summary in status.json"
exit 1
