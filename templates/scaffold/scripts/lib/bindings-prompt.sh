#!/usr/bin/env bash
# bindings-prompt.sh — read ## Tools and bindings from agent.md, prompt user, append YAML
#
# Args:
#   $1 = path to agent.md (the global agent contract)
#   $2 = path to instance config/default.yaml (will append tools: block)
#
# Behavior:
#   1. Extract YAML block from `## Tools and bindings` in agent.md
#   2. For each tool/key, prompt user via /dev/tty for value (showing required/optional + description)
#   3. Empty input or "skip" → write `# TODO: <description>` placeholder
#   4. Append a `tools:` block to the instance config
#
# Non-TTY environments fall back to TODO placeholders for every binding.

set -euo pipefail

AGENT_MD="${1:-}"
INSTANCE_CONFIG="${2:-}"

if [ -z "$AGENT_MD" ] || [ -z "$INSTANCE_CONFIG" ]; then
  echo "Usage: $0 <agent.md> <instance-config/default.yaml>" >&2
  exit 1
fi

if [ ! -f "$AGENT_MD" ]; then
  echo "ERROR: agent.md not found at $AGENT_MD" >&2
  exit 1
fi
if [ ! -f "$INSTANCE_CONFIG" ]; then
  echo "ERROR: instance config not found at $INSTANCE_CONFIG" >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "ERROR: python3 is required for bindings-prompt.sh" >&2
  exit 1
fi

# Drive prompts + YAML emission via python; pass file paths via env to avoid quoting hell.
export AGENT_MD INSTANCE_CONFIG

FINAL_YAML=$(python3 << 'PYEOF'
import os, re, sys

agent_md = os.environ["AGENT_MD"]
with open(agent_md) as f:
    content = f.read()

m = re.search(r'## Tools and bindings.*?\n```yaml\n(.*?)\n```', content, re.DOTALL)
if not m:
    sys.stderr.write(f"ERROR: no '## Tools and bindings' YAML block in {agent_md}\n")
    sys.exit(1)

schema_text = m.group(1)

try:
    import yaml
except ImportError:
    sys.stderr.write("ERROR: pyyaml required (pip3 install --user pyyaml)\n")
    sys.exit(1)

try:
    schema = yaml.safe_load(schema_text)
except Exception as e:
    sys.stderr.write(f"ERROR parsing bindings schema: {e}\n")
    sys.exit(1)

if not isinstance(schema, dict):
    sys.stderr.write("Bindings schema is not a YAML mapping\n")
    sys.exit(1)

# Try to open /dev/tty for interactive input. Fall back to all-TODO if unavailable.
try:
    tty = open("/dev/tty", "r")
    interactive = True
except OSError:
    tty = None
    interactive = False
    sys.stderr.write("(non-interactive environment — all bindings will be TODO placeholders)\n")

def yaml_quote(value: str) -> str:
    if value == "":
        return '""'
    if any(c in value for c in [":", "#", "@", "{", "}", "[", "]", ",", "&", "*", "!", "|", ">", "'", '"', "%", "`"]):
        escaped = value.replace('\\', '\\\\').replace('"', '\\"')
        return f'"{escaped}"'
    return value

out_lines = []
out_lines.append("")
out_lines.append("# Tool bindings (filled via chief-of-staff scaffolding prompt)")
out_lines.append("tools:")

for tool, bindings in schema.items():
    if not isinstance(bindings, dict):
        continue
    out_lines.append(f"  {tool}:")
    for key, meta in bindings.items():
        if not isinstance(meta, dict):
            continue
        required = bool(meta.get("required", False))
        description = str(meta.get("description", "") or "")
        marker = "(required)" if required else "(optional)"

        value = ""
        if interactive:
            sys.stderr.write(f"\n  {tool}.{key} {marker}\n")
            sys.stderr.write(f"    {description}\n")
            sys.stderr.write(f"    > ")
            sys.stderr.flush()
            try:
                value = tty.readline().strip()
            except (OSError, KeyboardInterrupt):
                value = ""

        if value == "" or value.lower() == "skip":
            out_lines.append(f"    {key}: # TODO: {description}")
        else:
            out_lines.append(f"    {key}: {yaml_quote(value)}")

print("\n".join(out_lines))

if tty is not None:
    tty.close()
PYEOF
)

# Append to instance config
{
  echo ""
  echo "$FINAL_YAML"
} >> "$INSTANCE_CONFIG"

echo "" >&2
echo "✓ Tool bindings appended to $INSTANCE_CONFIG" >&2
