<!-- roster:generated
schema_version: 1
generator: @firatcand/roster
generator_version: 1.8.1
protocol_version: 2
artifact: roster-bootstrap
host: neutral
activation_assurance: advisory-manual
supported_host_versions: *
attestation_fixture: none
content_hash: sha256:7b412a0419edbefad0512bca0d80cf66785cd56e61dc279cb468d5c97ef44cac
-->
# Roster workspace

Roster is the context and scaffolding layer for this repository. The host agent interprets plans and executes the work.

- Read `roster.yaml` for the workspace registry.
- Use `roster discover --json` to resolve purpose-built agents and records.
- Resolve canonical tool `skill_ref` values through `.roster/vendor-skill-map.json`; read verified workspace-relative skills and let the host resolve host-native identities.
- Use `roster scaffold` to add one explicitly requested authored record at a time.
- Preserve authored files and report generated-file drift instead of overwriting user changes.
