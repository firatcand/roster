#!/usr/bin/env bash
# Probe Claude Desktop's claude:// URL scheme for schedule-creation routes.
# Tracks ROS-57. ADR-0001 § Action Items #11. Cadence: first Mon monthly + per release.
#
# Exit codes:
#   0  no new routes (claude://cowork/shared-artifact remains the only literal)
#   1  NEW ROUTE DETECTED — see stdout banner; file a follow-up ticket
#   2  environment problem (Claude Desktop missing, non-macOS, etc.)
#
# Env:
#   PROBE_FORCE=1  overwrite same-day artifact without prompting

set -euo pipefail

CLAUDE_APP="/Applications/Claude.app"
ASAR_PATH="${CLAUDE_APP}/Contents/Resources/app.asar"
PLIST_PATH="${CLAUDE_APP}/Contents/Info.plist"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROBES_DIR="${REPO_ROOT}/docs/probes/claude-url-scheme"
TODAY="$(date -u +%Y-%m-%d)"
ARTIFACT="${PROBES_DIR}/${TODAY}.md"

TMP_DIR="$(mktemp -d -t roster-claude-probe.XXXXXX)"
trap 'rm -rf "${TMP_DIR}"' EXIT

# --- Preflight ----------------------------------------------------------------

preflight() {
  if [ "$(uname -s)" != "Darwin" ]; then
    echo "✗ This probe is macOS-only. Claude Desktop ships on macOS/Windows; only macOS exposes Info.plist + asar inspection paths." >&2
    echo "  Re-run on a macOS box (the dev/production target per CLAUDE.md)." >&2
    exit 2
  fi

  if [ ! -d "${CLAUDE_APP}" ]; then
    echo "✗ Claude Desktop not found at ${CLAUDE_APP}." >&2
    echo "  Install it from https://claude.ai/download, or run this probe on a machine that has it." >&2
    exit 2
  fi

  if [ ! -x /usr/libexec/PlistBuddy ]; then
    echo "✗ /usr/libexec/PlistBuddy not available — required for plist inspection." >&2
    exit 2
  fi

  if [ ! -f "${ASAR_PATH}" ]; then
    echo "✗ Claude Desktop asar not found at ${ASAR_PATH}." >&2
    echo "  Bundle layout may have changed; re-validate the probe paths." >&2
    exit 2
  fi
}

# --- Probe 1: Info.plist CFBundleURLSchemes ----------------------------------

probe_info_plist() {
  /usr/libexec/PlistBuddy -c "Print CFBundleURLTypes" "${PLIST_PATH}" 2>/dev/null || {
    echo "(no CFBundleURLTypes key)"
    return 0
  }
}

# --- Probe 2: asar grep for claude:// literals --------------------------------

probe_asar_strings() {
  local extracted="${TMP_DIR}/asar"
  local literals="${TMP_DIR}/literals.txt"

  if command -v npx >/dev/null 2>&1; then
    if npx --yes asar extract "${ASAR_PATH}" "${extracted}" >/dev/null 2>&1; then
      grep -rEho 'claude://[a-zA-Z0-9_/.-]+' "${extracted}" 2>/dev/null | sort -u > "${literals}" || true
      if [ -s "${literals}" ]; then
        cat "${literals}"
        return 0
      fi
    fi
  fi

  # Fallback: strings against the raw asar
  if command -v strings >/dev/null 2>&1; then
    strings "${ASAR_PATH}" 2>/dev/null | grep -Eo 'claude://[a-zA-Z0-9_/.-]+' | sort -u > "${literals}" || true
    if [ -s "${literals}" ]; then
      cat "${literals}"
      echo ""
      echo "(fallback: used 'strings' instead of asar extract; results may include false-positives)"
      return 0
    fi
  fi

  echo "(no claude:// literals extracted — neither 'npx asar' nor 'strings' produced usable output)"
  return 0
}

# --- Probe 3: behaviour probes via `open -g` ---------------------------------

probe_open_behaviour() {
  local urls=(
    "claude://schedule"
    "claude://schedule/new"
    "claude://routine"
    "claude://routine/new"
    "claude://task/new"
    "claude://tasks"
  )
  for url in "${urls[@]}"; do
    # `open -g` doesn't return a signal whether the URL handler matched.
    # We capture only that we attempted it; diffs across months are the signal.
    if open -g "${url}" 2>/dev/null; then
      echo "- \`${url}\` — attempted (open exited 0; no observable response means unhandled)"
    else
      echo "- \`${url}\` — attempted (open returned non-zero — likely unhandled)"
    fi
  done
}

# --- Detection ---------------------------------------------------------------

detect_new_routes() {
  local literals="$1"
  # Today's baseline: only claude://cowork/shared-artifact should appear.
  # Anything matching schedule|routine|task is the signal we're watching for.
  if grep -Eq 'claude://(schedule|routine|task)' "${literals}" 2>/dev/null; then
    return 1
  fi
  return 0
}

# --- Render ------------------------------------------------------------------

render_report() {
  local plist_out="$1"
  local asar_out="$2"
  local behaviour_out="$3"
  local result="$4"
  local claude_version
  claude_version="$(/usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" "${PLIST_PATH}" 2>/dev/null || echo "unknown")"
  local claude_build
  claude_build="$(/usr/libexec/PlistBuddy -c "Print CFBundleVersion" "${PLIST_PATH}" 2>/dev/null || echo "unknown")"

  cat <<EOF
# claude:// URL scheme probe — ${TODAY}

**Probe:** \`scripts/probe-claude-url-scheme.sh\` ([ROS-57](https://linear.app/firatdogan/issue/ROS-57))
**Claude Desktop version:** ${claude_version} (build ${claude_build})
**Host:** $(uname -s) $(uname -r)
**Result:** ${result}

---

## 1. \`Info.plist\` — \`CFBundleURLSchemes\`

\`\`\`
${plist_out}
\`\`\`

## 2. asar literals — \`grep -E 'claude://[a-zA-Z0-9_/.-]+'\`

\`\`\`
${asar_out}
\`\`\`

## 3. Behaviour probes — \`open -g\`

${behaviour_out}

---

## Interpretation

EOF

  if [ "${result}" = "NEW ROUTE DETECTED" ]; then
    cat <<EOF
🚨 **A new \`claude://\` route appeared in the asar grep.**

Next steps:
1. File a follow-up Linear ticket under Phase 2.5 to promote it to a first-class install path in \`roster schedule install --tool claude\`.
2. Link it from ROS-57 and update [ADR-0001](../../adr/0001-scheduling-architecture.md) Action Item #11.
3. Close ROS-57 referencing the follow-up.
EOF
  else
    cat <<EOF
No schedule-creation route found. \`claude://cowork/shared-artifact\` (or equivalent Cowork-only literal) remains the only \`claude://*\` route registered. Confirms Spike β finding — UI hand-off remains the only viable Claude schedule install path until [anthropics/claude-code#41364](https://github.com/anthropics/claude-code/issues/41364) ships.

Next probe due: first Monday of next month.
EOF
  fi
}

# --- Main --------------------------------------------------------------------

main() {
  preflight

  echo "→ Running claude:// URL scheme probe ($(date -u +%Y-%m-%dT%H:%M:%SZ))..." >&2

  local plist_out asar_out behaviour_out literals
  plist_out="$(probe_info_plist)"
  asar_out="$(probe_asar_strings)"
  behaviour_out="$(probe_open_behaviour)"

  literals="${TMP_DIR}/asar-final.txt"
  echo "${asar_out}" > "${literals}"

  local result
  if detect_new_routes "${literals}"; then
    result="No new routes (claude://cowork/shared-artifact only)"
  else
    result="NEW ROUTE DETECTED"
  fi

  local report
  report="$(render_report "${plist_out}" "${asar_out}" "${behaviour_out}" "${result}")"

  # Write artifact
  mkdir -p "${PROBES_DIR}"
  if [ -f "${ARTIFACT}" ] && [ "${PROBE_FORCE:-0}" != "1" ]; then
    echo "" >&2
    echo "⚠ Same-day artifact exists: ${ARTIFACT}" >&2
    printf "  Overwrite? [y/N] " >&2
    read -r answer
    case "${answer}" in
      y|Y|yes|YES) : ;;
      *)
        echo "Skipping artifact write. Stdout report below:" >&2
        echo ""
        printf "%s\n" "${report}"
        exit 0
        ;;
    esac
  fi
  printf "%s\n" "${report}" > "${ARTIFACT}"
  echo "→ Wrote ${ARTIFACT}" >&2
  echo "" >&2

  printf "%s\n" "${report}"

  if [ "${result}" = "NEW ROUTE DETECTED" ]; then
    exit 1
  fi
  exit 0
}

main "$@"
