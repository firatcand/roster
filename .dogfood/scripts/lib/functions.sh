# scripts/lib/functions.sh — shared helpers for reading the functions registry.
# Source from a script that has $ROOT set to repo root:
#   ROOT="$(cd "$(dirname "$0")/.." && pwd)"
#   source "$ROOT/scripts/lib/functions.sh"
#
# Provides:
#   read_functions               — print one slug per line from .config/functions.yaml
#   read_functions_with_metadata — print "<slug>\t<has_expert>" per line
#   is_valid_function <slug>     — return 0 if slug is registered, else 1

_have_pyyaml() {
  command -v python3 >/dev/null 2>&1 && python3 -c "import yaml" >/dev/null 2>&1
}

read_functions() {
  local config="${ROOT}/.config/functions.yaml"
  if [ ! -f "$config" ]; then
    echo "ERROR: $config not found" >&2
    return 1
  fi
  if _have_pyyaml; then
    python3 -c "
import yaml, re, sys
SLUG_RE = re.compile(r'^[a-z][a-z0-9-]*\$')
try:
    with open('$config') as f:
        data = yaml.safe_load(f) or {}
except yaml.YAMLError as e:
    sys.stderr.write('ERROR: malformed YAML in $config: ' + str(e) + '\n')
    sys.exit(1)
for fn in data.get('functions', []):
    slug = fn.get('slug', '')
    if not slug:
        continue
    if not SLUG_RE.match(slug):
        sys.stderr.write(\"ERROR: malformed slug '\" + slug + \"' in $config — must match ^[a-z][a-z0-9-]*\$\n\")
        sys.exit(1)
    print(slug)
" || return 1
  else
    local slug
    while IFS= read -r slug; do
      if ! [[ "$slug" =~ ^[a-z][a-z0-9-]*$ ]]; then
        echo "ERROR: malformed slug '$slug' in $config — must match ^[a-z][a-z0-9-]*\$" >&2
        return 1
      fi
      printf '%s\n' "$slug"
    done < <(grep -E '^[[:space:]]*-[[:space:]]*slug:[[:space:]]*' "$config" \
      | sed -E 's/^[[:space:]]*-[[:space:]]*slug:[[:space:]]*//; s/[[:space:]]*$//')
  fi
}

read_functions_with_metadata() {
  local config="${ROOT}/.config/functions.yaml"
  if [ ! -f "$config" ]; then
    echo "ERROR: $config not found" >&2
    return 1
  fi
  if _have_pyyaml; then
    python3 -c "
import yaml, sys
try:
    with open('$config') as f:
        data = yaml.safe_load(f) or {}
except yaml.YAMLError as e:
    sys.stderr.write('ERROR: malformed YAML in $config: ' + str(e) + '\n')
    sys.exit(1)
for fn in data.get('functions', []):
    slug = fn.get('slug', '')
    has_expert = bool(fn.get('has_expert', False))
    if slug:
        print(slug + '\t' + ('true' if has_expert else 'false'))
" || return 1
  else
    # Fallback: awk over flat YAML; track current slug and emit when has_expert seen.
    awk '
      /^[[:space:]]*-[[:space:]]*slug:[[:space:]]*/ {
        if (slug != "") print slug "\t" (he == "true" ? "true" : "false")
        slug = $0
        sub(/^[[:space:]]*-[[:space:]]*slug:[[:space:]]*/, "", slug)
        sub(/[[:space:]]*$/, "", slug)
        he = "false"
        next
      }
      /^[[:space:]]*has_expert:[[:space:]]*/ {
        v = $0
        sub(/^[[:space:]]*has_expert:[[:space:]]*/, "", v)
        sub(/[[:space:]]*$/, "", v)
        he = v
      }
      END {
        if (slug != "") print slug "\t" (he == "true" ? "true" : "false")
      }
    ' "$config"
  fi
}

is_valid_function() {
  local fn="$1"
  read_functions 2>/dev/null | grep -Fxq "$fn"
}
