# AGENTS.md

These instructions apply to the entire repository.

## Read first

Before changing code, read `README.md`, `docs/DESIGN.md`, and `docs/DEVELOPMENT.md`.

## Project invariants

- This is a serverless, read-only pCloud Remote MCP for Cloudflare Workers.
- Keep all pCloud operations read-only.
- Preserve Cloudflare Access and Worker-side Access JWT validation.
- Treat `PCLOUD_ROOT_PATH` as a hard virtual-root boundary when configured.
- Path-based tools must not escape the virtual root.
- Do not add ID-based access that can bypass a scoped virtual root.
- Return virtual paths rather than the hidden physical root prefix.
- Future `get_file_info` and `read_file` tools must reuse the same root-boundary rules.

## Public-ready repository policy

Treat every tracked file and commit as if the repository were already public.

Do not commit credentials, tokens, authorization codes, private deployment values, private file contents, task transcripts, or machine-specific notes. Generic configuration variable names may be documented, but developer-specific values must stay outside Git.

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

For code changes, run at minimum:

```powershell
npm.cmd run typecheck
```

If dependencies change, also run `npm.cmd install` before typechecking. Run any additional relevant checks introduced by the change, and do not claim checks that were not run.

## Documentation

Update public documentation when behavior, configuration, security boundaries, or architecture changes.

- `README.md`: user-facing current behavior
- `docs/DESIGN.md`: architecture and security decisions
- `docs/DEVELOPMENT.md`: contributor and agent workflow

Keep tracked documentation deployment-agnostic.

## Local-only agent instructions

Private or machine-specific Codex instructions should not be committed. Use an untracked `AGENTS.override.md` and/or `.codex-local/` files, excluded in the local clone via `.git/info/exclude`, as described in `docs/DEVELOPMENT.md`.

## Completion report

When finishing an implementation task, report:

1. files changed
2. implementation summary
3. validation commands and results
4. unresolved risks, assumptions, or follow-up work
