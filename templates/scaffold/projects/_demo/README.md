# _demo

Placeholder project for testing roster workflows. Rename or duplicate this directory to
create a real project — `scripts/new-project.sh <name>` automates that in Phase 2.

## Structure

```
projects/_demo/
├── guidelines/           # written by function-level experts (added in Phase 2)
├── config/default.yaml   # per-project agent config (added in Phase 2)
└── state.md              # session continuity notes (max 5 lines; updated via /save-state)
```

In Phase 1 this directory only proves `roster init` writes files to the right place. The
full project substrate lands when Phase 2 ships `templates/scaffold/` (see ROS-17).
