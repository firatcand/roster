# Contributing

Roster is casually maintained. Issues and PRs welcome but not guaranteed quick response.

## Reporting issues

When filing an issue, please include:

1. What you were trying to do
2. What you expected to happen
3. What actually happened
4. Your Claude Code version (`claude --version`)
5. Your OS

## Submitting PRs

1. Open an issue first to discuss large changes
2. Keep PRs focused — one concept per PR
3. Update relevant docs (architecture, API, howto) if behavior changes
4. Add a test case or reproduction steps where applicable
5. Make sure existing `audit-repo` passes

## What's in scope

- Bug fixes
- Documentation improvements
- New scripts following existing patterns
- Improvements to the audit / lesson schema
- Generalizing things that are still tied to opinions (when consensus emerges)

## What's NOT in scope

- Replacing the substrate-vs-artifacts model with something else (it's the core opinion)
- Adding language/LLM-CLI portability beyond Claude Code (orthogonal project)
- Hosting / multi-tenant features

## Style

- Follow existing patterns in scripts (bash, syntax-checked, tested)
- Filenames: lowercase kebab-case
- YAML over JSON for config files
- Markdown for everything human-readable

## Getting help

- Check existing issues
- Check `docs/` for design rationale
- Open an issue
