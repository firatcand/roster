---
name: fixture-docs-search
description: Fictional one-shot stdio JSON-RPC search over an embedded handbook corpus.
---

# fixture-docs: search

A fictional, deterministic retrieval surface shaped like a one-shot stdio
JSON-RPC server. This skill owns the entire provider contract — framing, the
`search` method, input schema, output schema, and authentication mechanics.
Workspace tool-use definitions carry only company policy and never restate
anything on this page.

## Invocation

Start the adjacent `invoke.mjs` executable and write exactly one JSON-RPC 2.0
request document to its stdin. The process answers with exactly one JSON-RPC
response document on stdout and exits. There is no session, no notification
stream, and no second request.

```
node invoke.mjs <<'EOF'
{"jsonrpc":"2.0","id":1,"method":"search","params":{"query":"...","collection":"...","exclude_status":[],"max_results":2,"fields":["..."]}}
EOF
```

The executable reads no environment variables, opens no sockets, spawns no
processes, and reads no files. Its whole corpus is embedded.

## Method `search`

- `query`: plain search terms; every term must match a document.
- `collection`: the single collection the caller may read.
- `exclude_status`: document statuses the caller must never see.
- `max_results`: hard cap on returned matches.
- `fields`: the exact output fields the caller requires per match.

## Output

`result.matches` is an array of match objects carrying exactly the requested
`fields`, ordered by `doc_id`. Errors use standard JSON-RPC error objects and
exit code 2.

## Authentication

None. This fixture is credential-free by construction. A real deployment would
resolve ambient credentials outside the workspace; credential material never
belongs in authored workspace files.
