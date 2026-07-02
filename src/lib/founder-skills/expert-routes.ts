// KNOWN_FOUNDER_SKILLS mirrors the skills routed by the shipped
// templates/scaffold/*/EXPERT.md tables. When firatcand/founder-skills renames
// or removes a skill, update the EXPERT.md route and this list together — the
// hermetic test in test/expert-routes.test.ts pins templates ↔ list, and its
// ROSTER_NETWORK_SMOKE-gated live check verifies the list against the GitHub
// catalog on network runs.
export const KNOWN_FOUNDER_SKILLS: readonly string[] = [
  'channel-expert',
  'copywriter-skill',
  'data-analysis',
  'design',
  'devops',
  'motion-picture',
  'plg-skill',
  'pricing',
  'product-position',
  'product-spec',
  'prospecting',
  'sales-skill',
  'script-writer-skill',
  'seo',
  'software-architect',
];

// Host-tool built-ins routed by EXPERT.md († footnote) — valid routes that are
// never in the founder-skills catalog and never synced by `roster skills sync`.
export const BUILTIN_SKILL_EXCEPTIONS: readonly string[] = ['frontend-design'];

const SKILLS_HEADING_RE = /^##\s+Skills\s*$/;
const ANY_HEADING_RE = /^#{1,6}\s/;
const SEPARATOR_CELL_RE = /^:?-+:?$/;

// Extract the second column of the FIRST `| Task | Skill |` table under
// `## Skills`. Parsing stops at any heading (so a `###` subsection's table is
// never picked up) and at the first non-table line once the table has started
// (so only the first table counts). Non-table prose before the table is
// skipped; the header row and `|---|---|` separator are skipped; backticks and
// the `†` built-in marker are stripped; routes are deduped.
export function parseExpertRoutes(markdown: string): string[] {
  const routes: string[] = [];
  const seen = new Set<string>();
  let inSkills = false;
  let tableStarted = false;
  for (const raw of markdown.split('\n')) {
    const line = raw.trim();
    if (!inSkills) {
      if (SKILLS_HEADING_RE.test(line)) inSkills = true;
      continue;
    }
    if (ANY_HEADING_RE.test(line)) break;
    if (!line.startsWith('|')) {
      if (tableStarted) break;
      continue;
    }
    tableStarted = true;
    const cells = line
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim());
    if (cells.length < 2) continue;
    if (cells.every((c) => SEPARATOR_CELL_RE.test(c))) continue;
    const route = cells[1]!.replace(/[`†]/g, '').trim();
    if (route === '' || route === 'Skill' || seen.has(route)) continue;
    seen.add(route);
    routes.push(route);
  }
  return routes;
}
