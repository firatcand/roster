---
last_processed_through: <not yet run>
last_run_summary: (none)
total_runs: 0
---

# Dreamer State

This file tracks the dreamer's processing state. It updates after each nightly reflection run.

On first run, the dreamer scans all runs/feedback from the beginning of repo history. Subsequent runs only process material newer than `last_processed_through`.

To reset (e.g., to re-process everything): edit `last_processed_through` to a past date or remove it.
