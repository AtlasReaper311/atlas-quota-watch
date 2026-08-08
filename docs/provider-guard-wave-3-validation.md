# Provider guard Wave 3 validation

This documentation-only change validates the Atlas Systems default-branch provider guard on `atlas-quota-watch`.

Expected protected path:

- pull requests required for the default branch;
- required native context `validate`;
- required context `Gardener native auto-merge barrier`;
- deletion blocked;
- non-fast-forward updates blocked;
- zero required approvals;
- no bypass actors.

This file does not change quota-watch source, alerting behaviour, workflows, provider settings, automation variables, deployment state, releases, or existing pull requests.
