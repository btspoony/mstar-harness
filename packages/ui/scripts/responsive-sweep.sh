#!/usr/bin/env bash
# Overflow sweep over every screen at three widths.
#
# Fails loudly. A sweep that reports nothing is indistinguishable from a sweep that
# measured nothing, and the difference between those two has already been mistaken for a
# pass once in this project: an eval that returned a parse error produced empty `over:`
# fields, which read as zero overflow. Every screen must answer, and every answer must
# parse, or this exits non-zero.
#
# Usage: packages/ui/scripts/responsive-sweep.sh <base-url-without-hash>
set -uo pipefail

BASE="${1:?usage: responsive-sweep.sh <base-url>}"
SCREENS=(
  overview issues workflows iterations projects
  workflow/20261026-narrow-pane-parity
  iteration/iter-20260811-panel-fixes
  project/_default
  issue/I-000870
)
WIDTHS=(375 720 1440)
FAIL=0

PROBE='(() => {
  const s = document.querySelector("article.screen"); if (!s) return "noscreen";
  const clips = (el) => { const o = getComputedStyle(el); return o.overflowX !== "visible" || o.overflowY !== "visible"; };
  const bad = [...s.querySelectorAll("*")].filter((e) => {
    if (e.closest(".table-wrap, .chart-wrap, pre")) return false;
    const p = e.parentElement; if (!p) return false;
    if (clips(p)) return false;
    const er = e.getBoundingClientRect(), pr = p.getBoundingClientRect();
    return er.width > 0 && er.right > pr.right + 1;
  }).map((e) => e.tagName.toLowerCase() + "." + String(e.className).split(" ")[0]);
  return JSON.stringify({ checked: s.querySelectorAll("*").length, over: bad.length, sample: bad.slice(0, 3), scroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 });
})()'

for width in "${WIDTHS[@]}"; do
  for screen in "${SCREENS[@]}"; do
    agent-browser open "${BASE}#${screen}" >/dev/null 2>&1
    agent-browser set viewport "$width" 900 >/dev/null 2>&1
    sleep 2
    raw="$(agent-browser eval "$PROBE" 2>&1 | tail -1)"
    value="$(printf '%s' "$raw" | python3 -c '
import json, sys
try:
    payload = json.loads(json.loads(sys.stdin.read()))
    # `checked` is the proof the probe looked: a sweep that evaluated nothing prints the
    # same "over 0" as a clean one, and this project has already mistaken one for the other.
    if payload.get("checked", 0) < 20:
        sys.exit(2)
    print(payload["over"], "scroll" if payload["scroll"] else "noscroll")
except Exception:
    sys.exit(1)
')" || {
      echo "FAIL ${width} ${screen}: probe did not answer with JSON (got: ${raw:0:80})" >&2
      FAIL=1
      continue
    }
    read -r over scroll <<<"$value"
    if [ "$over" != "0" ] || [ "$scroll" != "noscroll" ]; then
      echo "FAIL ${width} ${screen}: over=${over} ${scroll}" >&2
      FAIL=1
    fi
  done
  echo "swept @${width}: ${#SCREENS[@]} screens"
done

if [ "$FAIL" -ne 0 ]; then
  echo "responsive sweep failed" >&2
  exit 1
fi
echo "responsive sweep: no element leaves its parent, no page scrolls sideways"
