# pCloud MCP for Cloudflare Workers

A serverless, read-only remote MCP server for pCloud, designed to run on Cloudflare Workers.

> **Status:** Early design / development. The repository is currently private and will be made public after the initial implementation is ready.

## Goals

- Expose a small, purpose-built set of read-only pCloud tools over MCP.
- Run without a dedicated server by using Cloudflare Workers.
- Let each user self-host the Worker in their own Cloudflare account.
- Keep pCloud credentials and access tokens in the user's own environment.
- Support MCP-compatible AI clients such as ChatGPT through a remote MCP endpoint.

## Initial scope

Planned read-only tools:

- `list_folder`
- `search_files`
- `get_file_info`
- `read_file`

The initial release will **not** provide upload, delete, move, rename, or sharing operations.

## Authentication model for the initial release

Each deployment will use the user's own pCloud application credentials. Users will register their own pCloud application and store the Client ID / Client Secret in their own Cloudflare environment.

YoraLAB will not store or process users' pCloud access tokens.

A shared YoraLAB OAuth application may be technically possible and could simplify onboarding, but this is intentionally out of scope for the initial release. See `docs/DESIGN.md`.

## Runtime

- Cloudflare Workers
- Remote MCP over HTTP
- pCloud OAuth / API

## License

License is not finalized yet. AGPL-3.0 is currently the leading candidate.

## Project

Developed by **YoraLAB**.
