# Contributing

Roster is a casually maintained npm CLI. Issues and PRs welcome — response times vary.

## Reporting issues

Please include:

1. What you were trying to do
2. What you expected to happen
3. What actually happened (paste exit codes and error output verbatim)
4. Your roster version (`npx @firatcand/roster --version`)
5. Your host AI tool and version (e.g., `claude --version`, `codex --version`)
6. Your OS

## Submitting PRs

1. Open an issue first for larger changes — saves you a rewrite if scope is off
2. Keep PRs focused — one concept per PR
3. Update the relevant docs (`docs/HOWTO.md`, `docs/ARCHITECTURE.md`, `docs/API.md`) if behavior changes
4. Add a test case or reproduction steps where applicable

## Development setup

```bash
git clone https://github.com/firatcand/roster.git
cd roster
pnpm install      # Node 22.18+ or 24+
pnpm typecheck
pnpm build
pnpm test
pnpm smoke        # full pack + install + init end-to-end
```

The pre-PR gate is `pnpm typecheck && pnpm build && pnpm test`. When the diff touches `templates/scaffold/scripts/`, also run `pnpm test:scaffold-scripts`.

Read [CLAUDE.md](CLAUDE.md) for repo layout and conventions (ESM, kebab-case filenames, hand-rolled argv, no docstrings).

## What's in scope

- Bug fixes and docs improvements
- New `roster` subcommands following existing patterns
- New AI-tool targets (see `CLAUDE.md` → "Adding a new AI-tool target")
- Generalizations where a hard-coded path is now blocking a real use case

## What's not in scope

- Hosting / multi-tenant features (roster is local-only by design)
- Bundling [forge](https://github.com/firatcand/forge) functionality (separate, complementary project)

## Style

- TypeScript, ESM, strict mode. No CommonJS.
- Filenames: lowercase kebab-case
- YAML over JSON for config files
- No comments unless behavior is non-obvious; no docstrings
- Conventional commits: `feat(scope):`, `fix(scope):`, `chore(scope):`, `docs(scope):`. Reference the GitHub issue (`Closes #N`) when applicable.

## CI / branch protection

PRs into `main` run [.github/workflows/ci.yml](.github/workflows/ci.yml) — typecheck, test, build, `npm pack --dry-run`, `pnpm smoke`. Branch protection on `main` requires:

- `CI / verify` status check passes
- Branch up to date with `main`
- (Optional) Linear history

All third-party actions in `ci.yml` and `publish.yml` are pinned to 40-character commit SHAs (with a trailing `# vX.Y.Z` comment) and auto-updated weekly via [Dependabot](.github/dependabot.yml).

## Publishing / Releases

Releases trigger on tag push:

```bash
git tag v0.X.Y && git push origin v0.X.Y
```

The [publish workflow](.github/workflows/publish.yml) runs the full quality gate (`typecheck`, `test`, `build`), asserts the tag matches `package.json` version, publishes to npm with provenance, and creates a GitHub Release with auto-generated notes.

**Pre-release tags** (e.g., `v0.4.0-rc.1`) are detected by suffix, published to the `next` dist-tag on npm, and marked pre-release on GitHub. Stable tags publish to `latest`.

If a bad version ships: `npm deprecate @firatcand/roster@<version> "<reason>"` and publish the fix as the next patch. Never reuse a version number.

### One-time setup — `NPM_TOKEN` secret

1. Mint a Granular Access Token at [npmjs.com](https://www.npmjs.com/) → Account → Access Tokens → Generate New Token → Granular.
   - Permissions: **Read and write** scoped to `@firatcand/roster` (publish; deprecation kept manual).
   - Set an expiry (90–365 days recommended).
2. Repo → **Settings → Secrets and variables → Actions → New repository secret**.
   - Name: `NPM_TOKEN`
   - Value: the token from step 1.

No additional setup is needed for provenance — the workflow's `id-token: write` permission handles OIDC attestation automatically.

### One-time setup — `production` environment

The publish workflow's `workflow_dispatch` trigger lets a maintainer manually run a publish against an existing tag (used for partial-publish recovery). To prevent anyone with `Actions: write` from triggering an unreviewed publish, manual dispatches are gated behind a GitHub environment named `production` that requires maintainer approval. Tag-push releases are **not** gated — they run immediately.

1. **Settings → Environments → New environment**, name: `production`.
2. **Required reviewers:** add the maintainer. **Do not enable "Prevent self-review"** — this is a solo-maintainer project and enabling it would leave every dispatch permanently stuck.
3. **Wait timer:** 0.
4. **Deployment branches and tags:** leave on "All branches and tags." A `v*` tag rule sounds appealing as belt-and-suspenders but actually blocks `workflow_dispatch` — on dispatch, `github.ref` is the default branch, not the tag.

Because self-approval is allowed, the maintainer account becomes the only barrier between an `Actions: write` actor and an npm publish. **Enable TOTP-based 2FA on the GitHub account** (and on the npm account that owns `NPM_TOKEN`) as the compensating control.

After this, any manual `workflow_dispatch` of the publish workflow will pause in "Waiting for review" state until approved in the Actions UI.

## Getting help

- Check existing [issues](https://github.com/firatcand/roster/issues)
- Skim `docs/ARCHITECTURE.md` and `docs/roadmap.md`
- Open an issue
