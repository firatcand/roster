---
name: fixture-ledger-lookup
description: Fictional command-line lookup over an embedded company ledger snapshot.
---

# fixture-ledger: lookup

A fictional, deterministic command-line surface. This skill owns the entire
provider contract — invocation syntax, input schema, output schema, and
authentication mechanics. Workspace tool-use definitions carry only company
policy and never restate anything on this page.

## Invocation

Run the adjacent `invoke.mjs` executable with exactly one JSON argument passed
as a literal argv value, never through shell string interpolation:

```
node invoke.mjs '{"account_code":"...","ledger":"...","exclude_flags":[],"fields":["..."]}'
```

The executable reads no environment variables, opens no sockets, spawns no
processes, and reads no files. Its whole dataset is embedded.

## Input

- `account_code`: one lowercase account identifier.
- `ledger`: the single ledger partition the caller may read.
- `exclude_flags`: account flags the caller must never see.
- `fields`: the exact output fields the caller requires per result.

## Output

One JSON document on stdout: `{"results":[...]}`. Each result carries exactly
the requested `fields`. Exit code 0 on success, 2 on malformed input.

## Authentication

None. This fixture is credential-free by construction. A real deployment would
resolve ambient credentials outside the workspace; credential material never
belongs in authored workspace files.
