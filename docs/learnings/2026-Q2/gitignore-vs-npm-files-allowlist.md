# `.gitignore` and `npm pack` files allowlist diverge silently

> 2026-05-12 · ROS-17 · tags: [foundation, packaging, gitignore, npm]

## What we expected

`npm pack --dry-run` showing all `templates/scaffold/**` files in the tarball meant the scaffold was healthy. Tarball was 47.5 kB, 69 files — all the new content listed.

## What happened

`git status` after copying 60 files into `templates/scaffold/` quietly skipped 13 plan YAMLs across three nested `plans/` dirs (`chief-of-staff/plans/`, `dreamer/plans/`, `gtm/sdr/plans/`). The repo's `.gitignore` had unanchored `plans/` (meant for the top-level forge planning artifacts) which matched every nested `plans/` directory. `git add templates/scaffold` succeeded with no warning. Smoke test passed because pack uses the build tree, not the git index. Anyone cloning would have gotten a broken scaffold.

## Why

`npm pack` honors the `files` allowlist in `package.json` and **ignores `.gitignore` entirely** when `files` is specified. Two independent inclusion systems with no cross-check: git tracks based on `.gitignore`, npm packs based on `files`. A path can be shipped but untracked. Found it only because I scanned the staged file list manually before committing — there's no automated gate for "every file npm ships is also tracked in git."

## Next time

- Anchor top-level-only ignore rules with leading `/` (e.g., `/plans/`, `/spec/`) — bare directory names match recursively.
- Add a CI/smoke step: assert `git ls-files templates/` equals the file list from `npm pack --dry-run` (minus the `package/` prefix). Catches this entire class of divergence.
- Treat "shipping files via `files` allowlist" as a separate concern from "tracking files in git"; verify both, not just the pack output.
