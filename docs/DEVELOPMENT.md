# Development Workflow

This repository is intended to become public. Development should therefore keep tracked files and Git history public-ready even while the repository is private.

## Working model

The project uses a review-oriented workflow that separates design decisions from implementation work:

```text
requirements / design discussion
        |
        v
implementation task
        |
        v
code + validation + concise result report
        |
        v
review / next design decision
```

Coding agents such as Codex may handle repository-oriented implementation work, but security boundaries and public behavior should be treated as explicit design decisions rather than silently changed during implementation.

## Repository instructions

`AGENTS.md` contains the repository-wide rules for coding agents. Keep it generic and safe for public release.

It should contain durable project constraints such as:

- read-only pCloud behavior
- virtual-root enforcement
- authentication/security requirements
- validation commands
- documentation expectations

It should not contain private deployment values or one-off task history.

## Task prompts and temporary notes

A specific implementation prompt should normally be sent directly to the coding agent rather than stored in a tracked repository file.

A useful implementation prompt can follow this structure:

```markdown
## Goal
Describe the feature or fix.

## Decisions already made
List security and design constraints that should not be re-decided.

## Requirements
List observable behavior and important edge cases.

## Validation
List required checks. State explicitly whether deployment is allowed.

## Documentation
State which public docs should change, if any.

## Report back
Return changed files, implementation summary, validation results, and unresolved risks.
```

## Local-only Codex overrides

Codex can consume local agent instruction files such as `AGENTS.override.md`. If machine-specific or private instructions are useful, keep them out of Git.

For a single clone, add entries such as these to `.git/info/exclude`:

```text
AGENTS.override.md
.codex-local/
```

Then local files may be used without adding repository-wide ignore rules or committing private operational notes.

Do not store raw credentials or access tokens in local instruction files when they can be kept in the platform's secret/configuration facilities instead.

## Public-ready Git history

Do not rely on deleting the repository history before publication.

Instead:

- assume every commit may eventually become public
- keep credentials and private deployment details out of commits from the start
- do not commit temporary agent prompts or debugging transcripts
- avoid history rewrites unless a real secret or sensitive value must be removed

Before changing repository visibility, perform a separate history and secret review.

## Commit messages and Git actions

Commit messages are part of the public history and should be written with the same care as tracked documentation.

Use concise, neutral, project-focused commit messages that describe the technical change. Do not include:

- credentials, tokens, authorization codes, or private deployment values
- account IDs or private email addresses
- machine-specific paths
- personal pCloud filenames or other private user data
- raw debugging output or temporary investigation details
- task transcripts, private prompts, or conversation context
- unnecessary references to the coding agent, reviewer, or private collaboration workflow

When a commit is explicitly requested, review the staged diff for accidental secrets and private deployment values before committing.

A normal implementation task does not imply permission to commit or push. Unless the current task explicitly authorizes the relevant Git operation, leave changes uncommitted and do not push, amend, rebase, rewrite history, or force-push.

## Local setup

Install the dependency versions recorded in `package-lock.json`:

```powershell
npm.cmd ci
```

Run the TypeScript validation used by the project:

```powershell
npm.cmd run typecheck
```

Run the tracked unit and mocked Worker/MCP regression tests:

```powershell
npm.cmd test
```

The regression suite builds a temporary Wrangler dry-run bundle and uses only generated JWT keys and mocked pCloud responses. It does not require deployment credentials or contact a pCloud account.

Run the deployment bundle validation without publishing a Worker:

```powershell
npm.cmd run deploy -- --dry-run
```

Run the dependency vulnerability gate at the same severity used by CI:

```powershell
npm.cmd audit --audit-level=low
```

When intentionally changing package metadata or dependencies, use npm to update `package-lock.json`, review the lockfile diff, and repeat a clean `npm.cmd ci`. Do not edit generated lockfile entries by hand.

GitHub Actions runs the same credential-free checks, including the low-severity dependency audit, on pushes and pull requests. CI must remain fully mocked and must not receive pCloud, Cloudflare, or deployment credentials.

The PowerShell `.cmd` form is shown because some Windows environments block the `npm.ps1`/`npx.ps1` shims through execution policy.

## Deployment boundary

A normal coding task should stop after implementation and local validation unless deployment is explicitly part of that task.

Deployment-specific configuration belongs in Cloudflare rather than tracked source. The public repository may document variable names and expected formats, but it should not contain a developer's actual account-specific values.

## Completion report

Implementation work should end with a compact report containing:

1. changed files
2. what changed and why
3. validation actually run and its result
4. unresolved risks or decisions that need review

This report can be reviewed before deciding the next implementation task.
