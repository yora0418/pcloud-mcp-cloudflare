# pCloud MCP for Cloudflare Workers

A serverless, read-only remote MCP server for pCloud, designed to run on Cloudflare Workers.

> **Status:** Functional private prototype. Authenticated ChatGPT connectivity, pCloud OAuth, folder listing, scoped virtual roots, metadata search, file metadata, and bounded text reading are implemented. The repository is still private while the initial feature set and security review are completed.

## Goals

- Expose a small, purpose-built set of read-only pCloud tools over MCP.
- Run without a dedicated server by using Cloudflare Workers.
- Let each user self-host the Worker in their own Cloudflare account.
- Keep pCloud credentials and access tokens in the user's own environment.
- Support MCP-compatible AI clients such as ChatGPT through a remote MCP endpoint.
- Optionally expose only a chosen pCloud subtree as the MCP-visible root.

## Current read-only tools

- `hello` — connectivity test
- `list_folder` — list a virtual folder
- `search_files` — metadata-only search across names and virtual paths
- `get_file_info` — retrieve normalized metadata for an exact virtual file path
- `read_file` — read a supported text file at an exact virtual path

The initial release will **not** provide upload, delete, move, rename, folder creation, or sharing operations.

## Authentication model for the initial release

Each deployment uses the user's own pCloud application credentials. Users register their own pCloud application and keep the resulting access token in their own Cloudflare environment.

YoraLAB does not store or process users' pCloud access tokens.

A shared YoraLAB OAuth application may be technically possible and could simplify onboarding, but this is intentionally out of scope for the initial release. See `docs/DESIGN.md`.

## Deployment configuration

Runtime configuration includes:

- `TEAM_DOMAIN` — Cloudflare Access team domain
- `POLICY_AUD` — Cloudflare Access Application Audience tag
- `PCLOUD_API_HOST` — `api.pcloud.com` for US accounts or `eapi.pcloud.com` for EU accounts
- `PCLOUD_ROOT_PATH` — optional physical pCloud folder exposed as MCP `/`, for example `/Sync`

Secret configuration:

- `PCLOUD_ACCESS_TOKEN`

### Scoped virtual root

If:

```text
PCLOUD_ROOT_PATH=/Sync
```

then the MCP exposes:

```text
MCP /            -> pCloud /Sync
MCP /Documents   -> pCloud /Sync/Documents
```

All path-based tools stay beneath that virtual root. When a scoped root is configured, direct `folderId` access in `list_folder` is disabled so folder IDs cannot bypass the boundary.

If `PCLOUD_ROOT_PATH` is unset, the real pCloud root remains visible as `/`.

## Search behavior

`search_files` currently performs metadata search only. It uses pCloud recursive folder listing, walks the returned tree in the Worker, and performs case-insensitive substring matching against names and reconstructed virtual paths.

It does **not** search inside file contents.

## File metadata and text reading

`get_file_info` uses an exact virtual path and returns selected file metadata, including available image, audio, or video details. It does not accept a caller-supplied file ID, and it never returns the hidden physical root prefix.

`read_file` is text-only. It accepts supported text MIME types and a conservative text-extension allowlist when pCloud reports a generic MIME type. Binary and unsupported formats are rejected before their contents are fetched. It retrieves raw file bytes through a temporary pCloud content link and decodes them strictly as UTF-8; non-UTF-8 text is rejected. Support for additional encodings may be added later.

The default maximum file size is 256 KiB (`262144` bytes). A caller may lower that limit or raise it to at most 1 MiB (`1048576` bytes) with `maxBytes`. Files above the selected limit are rejected without a partial read. The raw response is checked against the same limit while it is received.

## Runtime

- Cloudflare Workers
- Cloudflare Access + Managed OAuth
- Remote MCP over HTTP
- pCloud OAuth / API

## Development

The repository is developed as if its tracked history were already public.

- `AGENTS.md` contains repository-wide guidance for coding agents.
- `docs/DEVELOPMENT.md` describes the contributor/agent workflow, local-only overrides, validation expectations, and public-ready Git practices.
- `docs/DESIGN.md` records architecture, security boundaries, and development phases.
- `EXPERIMENT_*.md` files record dated experiments and interoperability findings separately from permanent design decisions. See `EXPERIMENT_20260818_chatgpt_mcp_content_compatibility.md` for the ChatGPT MCP content-delivery observations from 2026-08-18.

Private task prompts, machine-specific notes, credentials, and deployment-specific values should remain outside tracked files.

## License

License is not finalized yet. AGPL-3.0 is currently the leading candidate.

## Project

Developed by **YoraLAB**.
