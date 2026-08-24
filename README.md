# pCloud MCP for Cloudflare Workers

A serverless, read-only remote MCP server for pCloud, designed to run on Cloudflare Workers.

> **Status:** v0.1 release candidate; publication is on hold. Production regression and the focused independent re-audit of the current remediation passed with no P0, P1, or P2 findings and no code or security release blocker. Two P3 follow-ups are non-blocking; improving client-abort testing against a more production-like runtime is deferred to post-v0.1 hardening. Publication remains pending post-merge `main` verification, the final pre-publication gate, and explicit release approval. The repository remains private, and no `v0.1.0` tag or GitHub Release has been created.

For installation and deployment, see the [self-hosting setup guide](docs/SETUP.md). Review [SECURITY.md](SECURITY.md) before exposing pCloud content to an MCP client.

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
- `get_image_content` — return a PNG or JPEG at an exact virtual path as MCP ImageContent
- `get_office_content` — return a DOCX, XLSX, or PPTX at an exact virtual path as an MCP embedded binary resource
- `read_file` — read a supported text file at an exact virtual path

The initial release will **not** provide upload, delete, move, rename, folder creation, or sharing operations.

## Authentication model for the initial release

Each deployment uses the user's own pCloud application credentials. Users register their own pCloud application and keep the resulting access token in their own Cloudflare environment.

YoraLAB does not store or process users' pCloud access tokens.

A shared YoraLAB OAuth application may be technically possible and could simplify onboarding, but this is intentionally out of scope for the initial release. See `docs/DESIGN.md`.

## Deployment configuration

Runtime configuration includes:

- `TEAM_DOMAIN` — Cloudflare Access team origin, `https://<team-name>.cloudflareaccess.com`
- `POLICY_AUD` — Cloudflare Access Application Audience tag
- `PCLOUD_API_HOST` — `api.pcloud.com` for US accounts or `eapi.pcloud.com` for EU accounts
- `PCLOUD_ROOT_PATH` — optional physical pCloud folder exposed as MCP `/`, for example `/Sync`
- `PCLOUD_SEARCH_MAX_FOLDER_CALLS` — optional complete-search folder-listing limit; defaults to `45` and may be raised to at most `1024`

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

Virtual path strings are used exactly as supplied: spaces at the beginning or end of a filename segment are preserved rather than trimmed. An omitted optional path defaults to `/`, while an explicitly empty path, empty segments, `.` or `..` segments, backslashes, control characters, unpaired UTF-16 surrogates, segments of 1,024 UTF-8 bytes or more, and complete paths over 16 KiB are rejected. The resolved physical path is subject to the same aggregate byte limit. Valid Unicode surrogate pairs are preserved without replacement.

If `PCLOUD_ROOT_PATH` is unset, the real pCloud root remains visible as `/`.

Read-only access prevents the MCP from modifying pCloud files, but it does not prevent an authorized MCP client from receiving readable file contents. Configure `PCLOUD_ROOT_PATH` to expose only a subtree whose contents may be disclosed to the connected client.

## Search behavior

`search_files` currently performs metadata search only. It requests one non-recursive pCloud folder listing at a time and walks folders iteratively in the Worker, performing case-insensitive substring matching against names and reconstructed virtual paths. Response-derived folder names are validated before they are joined to the already-scoped physical and virtual parent paths; caller-supplied or response-derived folder IDs are not used for traversal.

A production payload diagnostic measured the unfiltered recursive whole-tree response at more than 32 MiB, so v0.1 deliberately does not use pCloud `listfolder recursive=1` for search.

It does **not** search inside file contents.

Each folder response is independently limited to 4 MiB, and one `search_files` invocation may receive at most 16 MiB of pCloud folder-listing JSON in total. This aggregate byte budget is fixed even when `PCLOUD_SEARCH_MAX_FOLDER_CALLS` is increased. A complete search is limited to 10,000 metadata entries, 64 nesting levels, 2,048 pending folders, a conservative 2 MiB retained-path storage budget, a 1 MiB serialized metadata result, and by default 45 folder listings. Entries are validated incrementally, and an entry beyond the scan limit is rejected before entry-derived paths or results are allocated. `list_folder` and `get_file_info` use the same 1 MiB serialized-result budget. If an aggregate, response, or traversal safety limit is reached, the tool returns an explicit error instead of an incomplete result. `maxResults` continues to limit only the number of matches returned after a complete bounded traversal. Large trees can be split into complete searches by supplying narrower `path` values. On a compatible Workers plan with sufficient external-subrequest allowance, `PCLOUD_SEARCH_MAX_FOLDER_CALLS` may raise the per-search folder-listing limit to at most 1,024.

## File metadata, text reading, image content, and Office content

`get_file_info` uses an exact virtual path and returns selected file metadata, including available image, audio, or video details. It does not accept a caller-supplied file ID, and it never returns the hidden physical root prefix. pCloud file and folder IDs in metadata responses are returned only as exact decimal strings; an already-imprecise numeric ID is omitted unless pCloud's canonical string `id` can recover it. Safe numeric sizes retain their numeric representation; exact decimal size strings are preserved when supplied by pCloud, while already-imprecise numeric values are omitted.

`read_file` is text-only. It accepts supported text MIME types and a conservative text-extension allowlist when pCloud reports a generic MIME type. Binary and unsupported formats are rejected before their contents are fetched. It retrieves raw file bytes through a temporary pCloud content link and decodes them strictly as UTF-8; non-UTF-8 text is rejected. Support for additional encodings may be added later.

The default maximum file size is 256 KiB (`262144` bytes). A caller may lower that limit or raise it to at most 1 MiB (`1048576` bytes) with `maxBytes`. Files above the selected limit are rejected without a partial read. The raw response is checked against the same limit while it is received and must exactly match the metadata size.

`get_image_content` is a separate read-only path for PNG and JPEG files. It accepts an exact virtual path and returns the complete image directly as MCP ImageContent after validating metadata, source size, and the downloaded binary signature. The image source-file hard limit is 5 MiB (`5242880` bytes), independent of the smaller inline UTF-8 text limits used by `read_file`.

`get_office_content` is a separate read-only path for DOCX, XLSX, and PPTX files. It accepts an exact virtual path and returns the original file bytes with the format-specific MIME type as an MCP embedded binary resource. The Office source-file hard limit is 1 MiB (`1048576` bytes). The Worker checks the supported extension and MIME metadata plus the standard ZIP local-header signature, but does not inspect, decompress, or validate ZIP entries or XML. Office document validity and content interpretation are delegated to the MCP client. PDF, legacy Office formats, macro-enabled extensions, and arbitrary ZIP paths are not supported. ChatGPT MCP integration has confirmed native Office handling for all three supported formats; this validation does not claim quantitative parity with direct file uploads.

Office bytes are carried as an embedded resource inside the tool result; the Worker does not expose standalone `resources/list` or `resources/read` APIs. Other MCP clients must support embedded resource content in tool results to consume this output.

## Request safety limits

Authenticated `/mcp` POST bodies are streamed through a 256 KiB (`262144` byte) gate before they reach the MCP SDK. Requests over the limit receive HTTP 413. Top-level JSON arrays are rejected at this gate because v0.1 does not support legacy JSON-RPC batch dispatch. The Worker also applies a Cloudflare Rate Limiting binding to authenticated MCP POST requests at 120 requests per 60 seconds per verified Access principal. The binding is a protective, location-local approximate limiter rather than an accounting mechanism; binding absence or failure causes MCP POST requests to fail closed with HTTP 503.

pCloud JSON method parameters are sent in bounded POST form bodies rather than URL queries. Final outbound URLs are limited to 16 KiB after serialization, form parameters to 64 KiB, and caller-supplied unscoped folder IDs to canonical decimal strings of at most 128 digits. The Worker applies explicit per-fetch timeouts to Cloudflare Access JWKS retrieval, pCloud metadata and `getfilelink` requests, and temporary content downloads. Each MCP tool invocation also has a 45-second overall deadline; the shorter of that remaining deadline and the per-fetch timeout controls each pCloud request, and a disconnected client cancels outstanding and subsequent pCloud work. All pCloud redirects remain manual.

The v0.1 server does not publish events or use MCP subscriptions. The SDK's `subscriptions/listen` capacity is explicitly set to zero, so a listen request is rejected without opening a long-lived SSE stream. This does not change the seven registered tools.

## Observability and sensitive data

The tracked Worker configuration enables invocation logs at full sampling and explicitly disables Workers Traces. Application logging is limited to generic authentication or configuration failures; it must not include pCloud tokens, physical paths, temporary content URLs, filenames, file bytes, or base64 payloads. Traces remain disabled because automatic outbound-request metadata can disclose sensitive pCloud request targets. Self-hosters who change these settings are responsible for reviewing Cloudflare retention, access, and redaction behavior before enabling additional telemetry.

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

Private task prompts, machine-specific notes, credentials, and deployment-specific values should remain outside tracked files.

All registered tools declare MCP read-only, non-destructive, and idempotent annotations. Tools that access pCloud are also marked as open-world because their responses contain externally stored user content. These annotations describe behavior for clients; the Worker continues to enforce the read-only boundary independently.

## License

Licensed under the [AGPL-3.0-only](LICENSE) license.

Bug reports and contributions are welcome. Opening a GitHub Issue with clear details and reproduction steps is already a valuable contribution. Report potential security vulnerabilities privately as described in [SECURITY.md](SECURITY.md), without including credentials or sensitive details in a public Issue.

## Project

Developed by **YoraLAB**.
