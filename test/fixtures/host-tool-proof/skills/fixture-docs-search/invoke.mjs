const CORPUS = [
  {
    doc_id: 'handbook-legacy-09',
    title: 'Workspace initialization for retired tooling',
    collection: 'public-handbook',
    status: 'archived',
    body: 'Legacy workspace initialization steps kept for the record.',
  },
  {
    doc_id: 'handbook-setup-01',
    title: 'Workspace initialization basics',
    collection: 'public-handbook',
    status: 'current',
    body: 'Start every project with workspace initialization before inviting the team.',
  },
  {
    doc_id: 'handbook-setup-02',
    title: 'Workspace initialization checklist',
    collection: 'public-handbook',
    status: 'current',
    body: 'A reviewable workspace initialization checklist for new repositories.',
  },
  {
    doc_id: 'internal-notes-03',
    title: 'Workspace initialization internals',
    collection: 'private-notes',
    status: 'current',
    body: 'Private notes about workspace initialization internals.',
  },
];

function respond(id, body, exitCode) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...body })}\n`);
  process.exit(exitCode);
}

let raw = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) {
  raw += chunk;
  if (raw.length > 65536) respond(null, { error: { code: -32600, message: 'request too large' } }, 2);
}

let request;
try {
  request = JSON.parse(raw);
} catch {
  respond(null, { error: { code: -32700, message: 'parse error' } }, 2);
}
if (request === null || typeof request !== 'object' || Array.isArray(request)
  || request.jsonrpc !== '2.0'
  || (typeof request.id !== 'number' && typeof request.id !== 'string')) {
  respond(null, { error: { code: -32600, message: 'invalid request' } }, 2);
}
if (request.method !== 'search') {
  respond(request.id, { error: { code: -32601, message: 'method not found' } }, 2);
}
const params = request.params;
if (params === null || typeof params !== 'object' || Array.isArray(params)
  || typeof params.query !== 'string'
  || typeof params.collection !== 'string'
  || !Array.isArray(params.exclude_status) || params.exclude_status.some((status) => typeof status !== 'string')
  || !Number.isSafeInteger(params.max_results) || params.max_results < 1
  || !Array.isArray(params.fields) || params.fields.length === 0 || params.fields.some((field) => typeof field !== 'string')) {
  respond(request.id, { error: { code: -32602, message: 'invalid params' } }, 2);
}

const terms = params.query.toLowerCase().split(/\s+/).filter((term) => term.length > 0);
const matches = CORPUS
  .filter((doc) => doc.collection === params.collection
    && !params.exclude_status.includes(doc.status)
    && terms.every((term) => `${doc.title} ${doc.body}`.toLowerCase().includes(term)))
  .sort((left, right) => (left.doc_id < right.doc_id ? -1 : 1))
  .slice(0, params.max_results)
  .map((doc) => {
    const view = { doc_id: doc.doc_id, title: doc.title, snippet: doc.body.slice(0, 80) };
    const projected = {};
    for (const field of params.fields) {
      if (!(field in view)) respond(request.id, { error: { code: -32602, message: 'unknown output field' } }, 2);
      projected[field] = view[field];
    }
    return projected;
  });
respond(request.id, { result: { matches } }, 0);
