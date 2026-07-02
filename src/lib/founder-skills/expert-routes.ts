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
const SECTION_END_RE = /^#{1,2}\s/;
const SEPARATOR_CELL_RE = /^:?-+:?$/;

// Extract the second column of the `| Task | Skill |` table under `## Skills`,
// stopping at the next `#`/`##` heading. Skips the header row and the
// `|---|---|` separator, strips backticks and the `†` built-in marker, ignores
// non-table lines, and dedupes.
export function parseExpertRoutes(markdown: string): string[] {
  const routes: string[] = [];
  const seen = new Set<string>();
  let inSkills = false;
  for (const raw of markdown.split('\n')) {
    const line = raw.trim();
    if (SKILLS_HEADING_RE.test(line)) {
      inSkills = true;
      continue;
    }
    if (!inSkills) continue;
    if (SECTION_END_RE.test(line)) break;
    if (!line.startsWith('|')) continue;
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
