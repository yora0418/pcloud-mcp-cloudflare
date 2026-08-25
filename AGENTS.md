# AGENTS.md

These instructions apply to the entire repository.

## Read first

Before changing code, read `README.md`, `docs/DESIGN.md`, and `docs/DEVELOPMENT.md`. For deployment, configuration, or security-boundary work, also read `docs/SETUP.md` and `SECURITY.md`. When changing user-facing documentation, review both `README.md` and `README.ja.md`.

## Project invariants

- This is a serverless, read-only pCloud Remote MCP for Cloudflare Workers.
- Keep all pCloud operations read-only.
- Preserve Cloudflare Access and Worker-side Access JWT validation.
- Treat `PCLOUD_ROOT_PATH` as a hard virtual-root boundary when configured.
- Path-based tools must not escape the virtual root.
- Do not add ID-based access that can bypass a scoped virtual root.
- Return virtual paths rather than the hidden physical root prefix.
- All current and future path-based tools must reuse the same root-boundary rules.

## Public-ready repository policy

Treat every tracked file and commit as if the repository were already public.

Do not commit credentials, tokens, authorization codes, private deployment values, private file contents, task transcripts, or machine-specific notes. Generic configuration variable names may be documented, but developer-specific values must stay outside Git.

## Git and commit hygiene

Treat commit titles and bodies as public-facing project documentation.

- Keep commit messages concise, neutral, and focused on the repository change itself.
- Do not put secrets, tokens, authorization codes, account IDs, private email addresses, machine-specific paths, personal pCloud filenames, private deployment values, debugging dumps, task transcripts, or conversation context in commit messages.
- Do not describe a change using private user context when a generic technical description is sufficient.
- Do not mention temporary agent instructions or private collaboration details in commit messages.
- Before creating a requested commit, review the staged diff for accidental secrets or private deployment details.
- Do not create commits, push branches, amend commits, rebase, rewrite history, or force-push unless the current task explicitly authorizes that Git action.
- If committing was not explicitly requested, leave the implementation changes uncommitted and report the working-tree state instead.

## Deployment safety

Do not deploy or change external account configuration unless the user explicitly asks for that action in the current task. Code changes and local validation should not implicitly trigger deployment.

## Implementation guidance

- Keep the MCP surface small and task-oriented.
- Reuse shared path-resolution helpers for security-sensitive path handling.
- Validate user-controlled paths before calling pCloud.
- Bound potentially large MCP responses.
- Avoid unnecessary dependencies.
- Do not include secret values in errors or logs.

## Validation

For behavior, configuration, or security-boundary changes, run the relevant tests plus:

```powershell
npm.cmd run typecheck
npm.cmd run deploy -- --dry-run
```

Use `docs/DEVELOPMENT.md` and the current CI workflow to determine the complete validation gate for the change. Do not claim checks that were not run.

For dependency changes, use npm so `package-lock.json` is generated consistently, inspect the package and lockfile diff, validate from a clean `npm.cmd ci`, and then run the relevant validation gate, including the dependency audit when the dependency graph changed. Do not hand-edit generated lockfile entries.

## Documentation

Update public documentation when behavior, configuration, security boundaries, or architecture changes. Keep the existing documentation responsibilities clear instead of creating a second source of truth:

- `docs/DESIGN.md`: canonical source for implemented technical boundaries, architecture, major design decisions, numeric application limits, and implementation history.
- `SECURITY.md`: canonical source for security policy, threat model, reporting scope, sensitive-data handling, and deployment risks.
- `docs/SETUP.md`: canonical source for deployment configuration, operational setup, and troubleshooting.
- `README.md` and `README.ja.md`: user-facing overview, behavior, limitations, warnings, and setup routing. Keep those meanings aligned across both languages without requiring literal translation.
- `docs/DEVELOPMENT.md`: contributor and agent workflow and the repository validation process.

Do not introduce another tracked file to duplicate numeric limits, security boundaries, or operational configuration that already has a canonical home above. Keep tracked documentation deployment-agnostic.

## Local-only agent instructions

Private or machine-specific Codex instructions should not be committed. Use an untracked `AGENTS.override.md` and/or `.codex-local/` files, excluded in the local clone via `.git/info/exclude`, as described in `docs/DEVELOPMENT.md`.

## Completion report

When finishing an implementation task, report:

1. files changed
2. implementation summary
3. validation commands and results
4. unresolved risks, assumptions, or follow-up work
