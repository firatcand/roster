#!/usr/bin/env bash
# Subprocess test for templates/scaffold/scripts/audit-agent.sh's
# guideline_refs check (ROS-144). The check is WARN-only: a dangling,
# forbidden-prefix, escaping, or shape-mismatched ref must surface in the
# report's Warnings section and must NOT change the script's exit code.
#
# Why shell, not Node test runner: the target IS a shell script (same
# rationale as test/new-agent-slash-only.sh). Tests the shipped scaffold
# copy directly — no in-repo dogfood fixture. Invoked via
# `pnpm test:scaffold-scripts`.
#
# PyYAML strategy: the check is gated on `python3 + import yaml`. Dev
# machines (macOS in particular) often lack PyYAML, so:
#   - Cases that need yaml use fixtures written in JSON form (JSON is a
#     YAML subset — real PyYAML parses them identically). When real PyYAML
#     is absent, a PYTHONPATH shim provides a json-backed yaml.safe_load,
#     so the ref-check code paths under test always run for real.
#   - The pyyaml-missing case injects a poisoned yaml module via PYTHONPATH
#     (raises ImportError) so it is deterministic even where PyYAML exists.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SOURCE_AUDIT="$REPO_ROOT/templates/scaffold/scripts/audit-agent.sh"
SOURCE_LIB="$REPO_ROOT/templates/scaffold/scripts/lib/functions.sh"

if [ ! -f "$SOURCE_AUDIT" ]; then
  echo "ERROR: $SOURCE_AUDIT not found" >&2; exit 1
fi
if [ ! -f "$SOURCE_LIB" ]; then
  echo "ERROR: $SOURCE_LIB not found" >&2; exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "ERROR: python3 required for this test (the check under test is python-gated)" >&2; exit 1
fi

TMPDIR_ROOT="$(mktemp -d -t roster-guideline-refs-XXXXXXXX)"
PASS_COUNT=0
FAIL_COUNT=0

cleanup() {
  local rc=$?
  rm -rf "$TMPDIR_ROOT" 2>/dev/null || true
  echo ""
  echo "===> $PASS_COUNT passed, $FAIL_COUNT failed"
  if [ $rc -eq 0 ] && [ "$FAIL_COUNT" -eq 0 ]; then
    echo "===> audit-agent-guideline-refs PASS"
    exit 0
  else
    echo "===> audit-agent-guideline-refs FAIL"
    exit 1
  fi
}
on_signal() {
  # Separate from the EXIT trap so an interrupted run cannot double-print
  # the cleanup/summary block (bash runs the EXIT trap after a signal trap
  # unless it is cleared first).
  trap - EXIT
  rm -rf "$TMPDIR_ROOT" 2>/dev/null || true
  echo ""
  echo "===> audit-agent-guideline-refs INTERRUPTED"
  exit 130
}
trap cleanup EXIT
trap on_signal INT TERM

pass() { printf "  \033[32m✓\033[0m %s\n" "$1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { printf "  \033[31m✗\033[0m %s\n" "$1"; FAIL_COUNT=$((FAIL_COUNT + 1)); }

# yaml shim (JSON-subset loader) — used only when real PyYAML is absent.
SHIM_DIR="$TMPDIR_ROOT/yaml-json-shim"
mkdir -p "$SHIM_DIR"
cat > "$SHIM_DIR/yaml.py" <<'PY'
import json as _json


class YAMLError(Exception):
    pass


def safe_load(stream):
    data = stream.read() if hasattr(stream, "read") else stream
    if isinstance(data, bytes):
        data = data.decode("utf-8")
    if not data.strip():
        return None
    try:
        return _json.loads(data)
    except ValueError as exc:
        raise YAMLError(str(exc))
PY

# Poisoned yaml module — makes `import yaml` fail even where PyYAML exists.
POISON_DIR="$TMPDIR_ROOT/yaml-poison"
mkdir -p "$POISON_DIR"
cat > "$POISON_DIR/yaml.py" <<'PY'
raise ImportError("pyyaml intentionally unavailable (roster test shim)")
PY

if python3 -c "import yaml" >/dev/null 2>&1; then
  AUDIT_PP=""
  echo "(using real PyYAML)"
else
  AUDIT_PP="$SHIM_DIR"
  echo "(real PyYAML absent — using json-subset yaml shim via PYTHONPATH)"
fi

# make_workspace <dir> <registry-form: json|yaml>
# Lays out the minimal workspace audit-agent.sh expects: scripts/, registry,
# a gtm/test-agent tree whose agent.md carries every required section (so the
# only signal under test is the guideline_refs one), and guidelines/icps/.
make_workspace() {
  local ws="$1" registry_form="$2"
  mkdir -p "$ws/scripts/lib" "$ws/.config" "$ws/guidelines/icps" "$ws/gtm/test-agent/plans"
  cp "$SOURCE_AUDIT" "$ws/scripts/audit-agent.sh"
  cp "$SOURCE_LIB" "$ws/scripts/lib/functions.sh"
  if [ "$registry_form" = "json" ]; then
    # JSON form is valid YAML; parses identically under real PyYAML and the
    # json-subset shim.
    printf '%s\n' '{"functions": [{"slug": "gtm", "description": "go-to-market", "has_expert": false}]}' \
      > "$ws/.config/functions.yaml"
  else
    # Classic YAML form: needed by the poisoned-yaml case, where
    # read_functions degrades to its grep/sed fallback (which looks for
    # `- slug:` lines).
    cat > "$ws/.config/functions.yaml" <<'YAML'
functions:
  - slug: gtm
    description: go-to-market
    has_expert: false
YAML
  fi
  cat > "$ws/gtm/test-agent/agent.md" <<'MD'
# test-agent

## Purpose
x

## Inputs
x

## Plans
x

## Subagents
x

## Outputs
x

## Approval
x

## Lessons protocol
x
MD
  printf '# test-agent\n' > "$ws/gtm/test-agent/README.md"
}

# run_audit <ws> <pythonpath-or-empty> — stdout/stderr land in the workspace.
run_audit() {
  local ws="$1" pp="$2" rc=0
  if [ -n "$pp" ]; then
    ( cd "$ws" && PYTHONPATH="$pp" bash scripts/audit-agent.sh gtm test-agent ) \
      > "$ws/audit.stdout" 2> "$ws/audit.stderr" || rc=$?
  else
    ( cd "$ws" && bash scripts/audit-agent.sh gtm test-agent ) \
      > "$ws/audit.stdout" 2> "$ws/audit.stderr" || rc=$?
  fi
  return $rc
}

report_path() {
  sed -n 's/^Full report: //p' "$1/audit.stdout" | head -1
}

# assert_no_failures <report> <label> — warn-only proof: the report must not
# grow a Failures section (our scaffolded agent has none by construction).
assert_no_failures() {
  local report="$1" label="$2"
  if grep -q '^## Failures' "$report"; then
    fail "$label: report has a Failures section (check must be WARN-only)"
  else
    pass "$label: no Failures section (WARN-only confirmed)"
  fi
}

# -----------------------------------------------------------------------------
# Test 1: valid refs → schema validated, zero guideline_refs warnings
# -----------------------------------------------------------------------------
echo ""
echo "===> Test 1: valid refs produce no warning"
WS="$TMPDIR_ROOT/t1"
make_workspace "$WS" json
printf 'voice\n' > "$WS/guidelines/voice.md"
printf 'msg\n' > "$WS/guidelines/messaging.md"
printf 'persona\n' > "$WS/guidelines/icps/founder.md"
cat > "$WS/gtm/test-agent/config.yaml" <<'JSON'
{
  "agent": "gtm/test-agent",
  "plans_dir": "./plans/",
  "guideline_refs": {
    "voice": "/guidelines/voice.md",
    "icps": "/guidelines/icps/",
    "messaging": "/guidelines/messaging.md"
  },
  "tools": {}
}
JSON
if run_audit "$WS" "$AUDIT_PP"; then
  pass "exit 0 with valid refs"
else
  fail "exit non-zero with valid refs (stderr: $(cat "$WS/audit.stderr"))"
fi
REPORT="$(report_path "$WS")"
if [ -n "$REPORT" ] && [ -f "$REPORT" ]; then
  pass "report file written"
else
  fail "report file missing (stdout: $(cat "$WS/audit.stdout"))"
  REPORT=/dev/null
fi
if grep -qF "[gtm/test-agent/config.yaml] valid (schema)" "$REPORT"; then
  pass "schema check ran (not the pyyaml-missing degrade path)"
else
  fail "schema check did not run — ref check untested (report: $(cat "$REPORT"))"
fi
if grep -q "guideline_refs\." "$REPORT"; then
  fail "unexpected guideline_refs warning for valid refs: $(grep "guideline_refs\." "$REPORT")"
else
  pass "no guideline_refs warnings for valid refs"
fi

# -----------------------------------------------------------------------------
# Test 2: dangling ref → warning + exit 0
# -----------------------------------------------------------------------------
echo ""
echo "===> Test 2: dangling ref warns without failing"
WS="$TMPDIR_ROOT/t2"
make_workspace "$WS" json
printf 'msg\n' > "$WS/guidelines/messaging.md"
cat > "$WS/gtm/test-agent/config.yaml" <<'JSON'
{
  "agent": "gtm/test-agent",
  "plans_dir": "./plans/",
  "guideline_refs": {
    "voice": "/guidelines/voice.md",
    "messaging": "/guidelines/messaging.md"
  },
  "tools": {}
}
JSON
if run_audit "$WS" "$AUDIT_PP"; then
  pass "exit 0 despite dangling ref (warn must not change exit code)"
else
  fail "exit non-zero on dangling ref (stderr: $(cat "$WS/audit.stderr"))"
fi
REPORT="$(report_path "$WS")"
[ -n "$REPORT" ] && [ -f "$REPORT" ] || { fail "report file missing"; REPORT=/dev/null; }
if grep -qF "guideline_refs.voice" "$REPORT" && grep -qF "does not exist" "$REPORT"; then
  pass "dangling ref warned with 'does not exist'"
else
  fail "missing dangling-ref warning (report: $(cat "$REPORT"))"
fi
if grep -qF "guideline_refs.messaging" "$REPORT"; then
  fail "valid sibling ref wrongly warned"
else
  pass "valid sibling ref not warned (per-key behavior)"
fi
if grep -qF "agent runtime will fail to load this ref" "$REPORT"; then
  pass "warning states the runtime consequence"
else
  fail "warning missing runtime-consequence text"
fi
if grep -qF "[gtm/test-agent/config.yaml] base schema valid (guideline_refs warnings below)" "$REPORT"; then
  pass "passed line downgraded to 'base schema valid' when ref warnings exist"
else
  fail "passed line still claims full schema validity despite ref warnings"
fi
assert_no_failures "$REPORT" "dangling ref"

# -----------------------------------------------------------------------------
# Test 3: forbidden absolute fs prefix → warning + exit 0
# -----------------------------------------------------------------------------
echo ""
echo "===> Test 3: forbidden absolute prefixes warn"
WS="$TMPDIR_ROOT/t3"
make_workspace "$WS" json
cat > "$WS/gtm/test-agent/config.yaml" <<'JSON'
{
  "agent": "gtm/test-agent",
  "plans_dir": "./plans/",
  "guideline_refs": {
    "brand_book": "/Users/evil/brand-book.md",
    "tmp_ref": "/tmp/foo.md"
  },
  "tools": {}
}
JSON
if run_audit "$WS" "$AUDIT_PP"; then
  pass "exit 0 despite forbidden refs"
else
  fail "exit non-zero on forbidden refs (stderr: $(cat "$WS/audit.stderr"))"
fi
REPORT="$(report_path "$WS")"
[ -n "$REPORT" ] && [ -f "$REPORT" ] || { fail "report file missing"; REPORT=/dev/null; }
for key in brand_book tmp_ref; do
  if grep -qF "guideline_refs.$key" "$REPORT"; then
    pass "forbidden ref '$key' warned"
  else
    fail "forbidden ref '$key' not warned (report: $(cat "$REPORT"))"
  fi
done
if grep -qF "runtime loader will reject this ref" "$REPORT"; then
  pass "warning says the runtime loader will reject it"
else
  fail "warning missing loader-rejection text"
fi
assert_no_failures "$REPORT" "forbidden refs"

# -----------------------------------------------------------------------------
# Test 4: pyyaml missing → explicit 'guideline_refs not checked' message
# -----------------------------------------------------------------------------
echo ""
echo "===> Test 4: pyyaml-missing skip is explicit, never silent"
WS="$TMPDIR_ROOT/t4"
make_workspace "$WS" yaml
cat > "$WS/gtm/test-agent/config.yaml" <<'YAML'
agent: gtm/test-agent
plans_dir: ./plans/
guideline_refs:
  voice: /guidelines/does-not-exist.md
tools: {}
YAML
if run_audit "$WS" "$POISON_DIR"; then
  pass "exit 0 with pyyaml missing"
else
  fail "exit non-zero with pyyaml missing (stderr: $(cat "$WS/audit.stderr"))"
fi
REPORT="$(report_path "$WS")"
[ -n "$REPORT" ] && [ -f "$REPORT" ] || { fail "report file missing (stdout: $(cat "$WS/audit.stdout"))"; REPORT=/dev/null; }
if grep -qF "guideline_refs not checked" "$REPORT" && grep -qF "pyyaml missing" "$REPORT"; then
  pass "skip message names guideline_refs explicitly"
else
  fail "missing explicit 'guideline_refs not checked' message (report: $(cat "$REPORT"))"
fi
if grep -qF "guideline_refs.voice" "$REPORT"; then
  fail "ref check ran despite pyyaml shim (shim broken)"
else
  pass "ref check genuinely skipped (dangling ref not warned)"
fi

# -----------------------------------------------------------------------------
# Test 5: runtime-loader semantics mirror — escape, shape, type, relative
# -----------------------------------------------------------------------------
echo ""
echo "===> Test 5: mirror semantics (escape / dir-shape / non-string / relative)"
WS="$TMPDIR_ROOT/t5"
make_workspace "$WS" json
printf 'voice\n' > "$WS/guidelines/voice.md"
printf 'persona\n' > "$WS/guidelines/icps/founder.md"
cat > "$WS/gtm/test-agent/config.yaml" <<'JSON'
{
  "agent": "gtm/test-agent",
  "plans_dir": "./plans/",
  "guideline_refs": {
    "escape": "/guidelines/../../outside.md",
    "icps_no_slash": "/guidelines/icps",
    "voice_dir": "/guidelines/voice.md/",
    "num_ref": 42,
    "relative": "guidelines/voice.md"
  },
  "tools": {}
}
JSON
if run_audit "$WS" "$AUDIT_PP"; then
  pass "exit 0 despite five bad refs"
else
  fail "exit non-zero on mirror-semantics refs (stderr: $(cat "$WS/audit.stderr"))"
fi
REPORT="$(report_path "$WS")"
[ -n "$REPORT" ] && [ -f "$REPORT" ] || { fail "report file missing"; REPORT=/dev/null; }
if grep -qF "guideline_refs.escape" "$REPORT" && grep -qF "escapes outside the workspace root" "$REPORT"; then
  pass "escaping ref warned"
else
  fail "escaping ref not warned"
fi
if grep -qF "guideline_refs.icps_no_slash" "$REPORT" && grep -qF "is not a regular file" "$REPORT"; then
  pass "dir referenced without trailing '/' warned"
else
  fail "dir-without-trailing-slash not warned"
fi
if grep -qF "guideline_refs.voice_dir" "$REPORT" && grep -qF "is not a directory" "$REPORT"; then
  pass "file referenced with trailing '/' warned"
else
  fail "file-with-trailing-slash not warned"
fi
if grep -qF "guideline_refs.num_ref" "$REPORT" && grep -qF "not a non-empty string" "$REPORT"; then
  pass "non-string ref value warned"
else
  fail "non-string ref value not warned"
fi
if grep -qF "guideline_refs.relative" "$REPORT" && grep -qF "must start with '/'" "$REPORT"; then
  pass "relative (no leading '/') ref warned"
else
  fail "relative ref not warned"
fi
assert_no_failures "$REPORT" "mirror semantics"

# -----------------------------------------------------------------------------
# Test 6: real symlink escaping the workspace root — the ref is lexically
# inside the workspace, but realpath resolves to an existing file outside it,
# exercising the post-realpath containment check.
# -----------------------------------------------------------------------------
echo ""
echo "===> Test 6: symlink escaping the workspace root"
WS="$TMPDIR_ROOT/t6"
make_workspace "$WS" json
OUTSIDE_TARGET="$TMPDIR_ROOT/outside-target.md"
printf 'outside the workspace\n' > "$OUTSIDE_TARGET"
ln -s "$OUTSIDE_TARGET" "$WS/guidelines/link-out.md"
cat > "$WS/gtm/test-agent/config.yaml" <<'JSON'
{
  "agent": "gtm/test-agent",
  "plans_dir": "./plans/",
  "guideline_refs": {
    "symlink_out": "/guidelines/link-out.md"
  },
  "tools": {}
}
JSON
if run_audit "$WS" "$AUDIT_PP"; then
  pass "exit 0 despite symlink-escaping ref"
else
  fail "exit non-zero on symlink escape (stderr: $(cat "$WS/audit.stderr"))"
fi
REPORT="$(report_path "$WS")"
[ -n "$REPORT" ] && [ -f "$REPORT" ] || { fail "report file missing"; REPORT=/dev/null; }
if grep -qF "guideline_refs.symlink_out" "$REPORT" && grep -qF "resolves via symlink outside the workspace root" "$REPORT"; then
  pass "symlink escape warned via realpath containment check"
else
  fail "symlink escape not warned (report: $(cat "$REPORT"))"
fi
assert_no_failures "$REPORT" "symlink escape"
