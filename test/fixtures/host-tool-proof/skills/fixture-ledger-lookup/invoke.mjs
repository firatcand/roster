const DATASET = [
  {
    account_code: 'op-4210',
    account_name: 'cloud infrastructure',
    ledger: 'fiscal-operations',
    flags: [],
    balance_minor_units: 482155,
    currency: 'EUR',
    snapshot_id: 'fixture-snapshot-0007',
  },
  {
    account_code: 'op-9905',
    account_name: 'internal reserve',
    ledger: 'fiscal-operations',
    flags: ['internal-only'],
    balance_minor_units: 9100000,
    currency: 'EUR',
    snapshot_id: 'fixture-snapshot-0007',
  },
  {
    account_code: 'ty-0001',
    account_name: 'treasury cash',
    ledger: 'treasury',
    flags: [],
    balance_minor_units: 12000000,
    currency: 'EUR',
    snapshot_id: 'fixture-snapshot-0007',
  },
];

function fail(message) {
  process.stdout.write(`${JSON.stringify({ error: message })}\n`);
  process.exit(2);
}

if (process.argv.length !== 3) fail('expected exactly one JSON argument');
let input;
try {
  input = JSON.parse(process.argv[2]);
} catch {
  fail('the argument is not valid JSON');
}
if (input === null || typeof input !== 'object' || Array.isArray(input)) fail('input must be an object');
const { account_code: accountCode, ledger, exclude_flags: excludeFlags, fields } = input;
if (typeof accountCode !== 'string' || typeof ledger !== 'string') fail('account_code and ledger must be strings');
if (!Array.isArray(excludeFlags) || excludeFlags.some((flag) => typeof flag !== 'string')) fail('exclude_flags must be a string array');
if (!Array.isArray(fields) || fields.length === 0 || fields.some((field) => typeof field !== 'string')) fail('fields must name at least one output field');

const results = DATASET
  .filter((account) => account.account_code === accountCode
    && account.ledger === ledger
    && !account.flags.some((flag) => excludeFlags.includes(flag)))
  .map((account) => {
    const projected = {};
    for (const field of fields) {
      if (!(field in account)) fail('an unknown output field was requested');
      projected[field] = account[field];
    }
    return projected;
  });
process.stdout.write(`${JSON.stringify({ results })}\n`);
