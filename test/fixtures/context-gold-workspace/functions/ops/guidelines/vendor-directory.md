---
schema_version: 2
id: vendor-directory
kind: guideline
purpose: Define how the vendor directory is maintained as the single naming authority for vendor records.
scope:
  function: ops
---

# Vendor directory

The vendor directory is the naming authority every operations record leans on: one
canonical name per vendor, one canonical name per contracted service, and the
registry identifiers the failure-signature search depends on.

A vendor enters the directory at contract signature, through onboarding, with its
canonical name, its services, its registry identifiers, and the commitment summary
the escalation policy measures against. Nothing else in the operations tree may
introduce a vendor name; a ticket naming an unlisted vendor is an intake defect.

Renames happen in the directory first, with the old name retained as an alias so
archive searches keep finding history. A rename that happens in tickets before the
directory produces two vendors in every later query, which is how precedent quietly
disappears.

Service retirement is recorded, never deleted: a retired service keeps its history
and its identifiers, marked retired with the date, because incident timelines and
renewal evidence routinely reach back past retirement dates.

The directory is reviewed at every renewal and every onboarding, and drift found in
review — an alias missing, a commitment summary stale — is fixed in the directory
the same day, with the correcting change noted on the triggering ticket.

## Directory of record claims

Any document that needs a vendor fact — a scorecard, a renewal brief, an incident
summary — cites the directory rather than restating the fact, so a directory
correction propagates by reference. A restated vendor fact found in review is
replaced with a citation the same day.
