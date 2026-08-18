# Design Notes

This document records the initial design decisions for `pcloud-mcp-cloudflare`.

## Purpose

Provide a serverless, read-only remote MCP interface to pCloud so MCP-compatible AI clients can find and read a user's own files without requiring a dedicated server.

## Architecture

```text
MCP-compatible AI client
        |
        | Remote MCP + OAuth
        v
Cloudflare Access
        |
        | signed Access JWT
        v
Cloudflare Worker
        |
        | pCloud OAuth / API
        v
pCloud
```

The public repository contains the software. Each user deploys their own Worker instance and supplies their own credentials and Access configuration.

## Initial security boundary

The initial version is intentionally read-only.

Allowed capabilities:

- list folders
- search file/folder metadata and virtual paths
- retrieve file metadata
- read supported file contents

Explicitly out of scope for v1:

- upload
- delete
- move
- rename
- create folders
- create shares / public links
- modify file contents

### MCP endpoint protection

The production Worker is protected by Cloudflare Access before any pCloud data is exposed.

The Worker also validates the signed JWT supplied by Access in the `Cf-Access-Jwt-Assertion` header. Validation checks:

- the JWT signature against the Cloudflare Access JWKS endpoint
- the issuer against the deployment's Cloudflare One team domain
- the audience against the deployment's Access Application Audience (AUD) tag

These deployment-specific values are provided as Worker environment variables:

- `TEAM_DOMAIN`
- `POLICY_AUD`

They are configuration values rather than application secrets, but are intentionally not committed as developer-specific values because each self-hosted deployment has its own Access configuration.

Cloudflare Managed OAuth is used so compatible non-browser MCP clients can authenticate through Access. The client receives an opaque OAuth token; Cloudflare resolves it at the edge and forwards the signed Access assertion to the Worker.

## Initial pCloud authentication model

For the first release, every user registers their own pCloud application and stores their own pCloud credentials in their own Cloudflare environment.

Goals of this choice:

- no user access tokens are stored by YoraLAB
- no YoraLAB credential needs to be distributed to self-hosted instances
- the initial implementation stays simple
- shared OAuth onboarding work is deferred until there is evidence that users actually need it

The Worker uses:

- `PCLOUD_ACCESS_TOKEN` as a secret
- `PCLOUD_API_HOST` as deployment configuration (`api.pcloud.com` for US or `eapi.pcloud.com` for EU)
- optional `PCLOUD_ROOT_PATH` as the physical pCloud folder exposed as the MCP-visible `/`

### Future possibility: shared OAuth application

It may be possible to use a shared YoraLAB pCloud OAuth application so users would not need to register their own pCloud app.

This has **not** been investigated in enough depth for the initial release. Open questions include:

- how to use a shared OAuth client safely with independently hosted Cloudflare Workers
- whether Code Flow, Token/Implicit Flow, or an OAuth broker is most appropriate
- how redirect URIs should work across self-hosted deployments
- how to avoid distributing a shared `client_secret`

This is deliberately deferred. Contributions and experiments are welcome. If someone implements this in a fork, publishing the source and contributing the work upstream is encouraged.

## Virtual root / scope boundary

A deployment may set `PCLOUD_ROOT_PATH` to expose only a subtree of the pCloud account.

Example:

```text
PCLOUD_ROOT_PATH=/Sync
```

Then MCP-visible paths are mapped as follows:

```text
MCP /              -> pCloud /Sync
MCP /Documents     -> pCloud /Sync/Documents
MCP /Music/Album   -> pCloud /Sync/Music/Album
```

This is a security and usability boundary, not merely a default folder.

Rules:

- all path-based tools resolve virtual paths beneath `PCLOUD_ROOT_PATH`
- virtual paths must be absolute and cannot contain empty, `.` or `..` segments
- when `PCLOUD_ROOT_PATH` is a subfolder, direct `folderId` access is disabled in `list_folder` so an ID cannot bypass the scoped root
- tool responses expose virtual paths rather than the physical root prefix
- future tools such as `get_file_info` and `read_file` must use the same path-resolution boundary

If `PCLOUD_ROOT_PATH` is unset, `/` means the real pCloud root for backward compatibility and general self-hosted use.

## MCP tool design

The MCP surface should be small and task-oriented rather than mirroring the full pCloud API.

### `list_folder`

List entries in a folder. Paths are virtual paths relative to the configured MCP root.

For scoped deployments, direct folder IDs are not accepted because they could bypass the virtual-root boundary.

### `search_files`

Search file/folder metadata under a virtual path. The initial implementation is intentionally metadata-only:

- case-insensitive substring matching
- file/folder names
- reconstructed virtual relative paths
- optional folder matches
- bounded returned result count

pCloud's documented API does not expose a dedicated general filename search method. The initial implementation therefore uses `listfolder` with recursive listing and searches the returned metadata tree in the Worker.

This is **not** full-text content search.

Possible future evolution:

- cached metadata index
- Cloudflare KV / D1 backed index
- incremental updates using pCloud change information
- full-text indexing for supported document formats

### `get_file_info`

Return normalized metadata for a specific virtual file path while enforcing the same virtual-root boundary. The tool is path-only, rejects folders, and may include bounded image, audio, or video metadata supplied by pCloud. It does not expose the physical pCloud path.

### `read_file`

Retrieve a supported text file by virtual path while applying the same virtual-root boundary. The initial implementation:

- defaults to a complete-file limit of 256 KiB and allows at most 1 MiB
- checks pCloud metadata for file type and size before retrieving content
- allows text MIME types and a conservative extension fallback for generic MIME types
- obtains a temporary content request through `getfilelink` and accepts only HTTPS content hosts matching `*.pcloud.com`
- fetches raw bytes without following redirects, enforces the byte limit while receiving them, and decodes them strictly as UTF-8
- rejects folders, binary formats, unsupported types, non-UTF-8 text, oversized files, and partial reads; support for additional text encodings may be added later
- does not expose physical paths, temporary download URLs, or caller-supplied file-ID access

## pCloud-specific implementation notes

Implementation must account for pCloud's API/OAuth behavior, including regional API host handling where required.

The pCloud root folder has folder ID `0`, but scoped deployments intentionally avoid treating that physical root as the MCP root.

pCloud supports recursive `listfolder`; recursive results contain nested folder `contents`. Recursive metadata may omit full paths, so the MCP reconstructs virtual paths from folder names while walking the tree.

Existing open-source pCloud MCP implementations may be used as references for pCloud-specific API behavior, but this project is a new Cloudflare Workers-oriented implementation rather than a fork of a server-based MCP implementation.

## Cloudflare design

The project targets Cloudflare Workers directly rather than requiring a long-running server or container.

Characteristics:

- stateless remote MCP endpoint where practical
- Cloudflare Access in front of the production Worker
- Managed OAuth for compatible MCP clients
- Worker-side Access JWT validation as defense in depth
- secrets stored using Cloudflare's secret facilities, never committed to Git
- deployment-specific non-secret configuration stored in Worker environment variables
- minimal dependencies
- no dedicated VPS / home server requirement

`keep_vars` is enabled in Wrangler so self-hosters can configure deployment-specific variables in the Cloudflare dashboard without having those values removed by subsequent GitHub/Wrangler deployments.

## Deployment / ownership model

```text
YoraLAB GitHub repository
        |
        | clone / fork / deploy
        v
User's Cloudflare account
        |
        v
User's pCloud account
```

YoraLAB provides the software; YoraLAB does not host users' personal pCloud access in the initial model.

The developer's own production instance likewise runs in the developer's personal Cloudflare account rather than the YoraLAB public-service account.

## Repository visibility

Development begins in a private repository. The repository is intended to become public once the initial implementation is functional and reviewed for accidental credential or personal-data exposure.

## License

AGPL-3.0 is the current leading candidate, but the license has not been finalized yet.

Rationale under consideration: if modified versions are offered to other users as a network service, improvements should ideally remain available as source code. Final license selection should be made before public release.

## Development phases

### Phase 0 — MCP skeleton — complete

- create the Cloudflare Workers project
- expose a minimal remote MCP endpoint
- add a harmless `hello` test tool
- verify with an MCP inspector/client

### Phase 1 — AI client connectivity — complete

- connect ChatGPT
- verify that the test tool can be discovered and called

### Phase 1A — MCP endpoint protection — complete

- protect the Worker with Cloudflare Access
- enable Managed OAuth
- validate `Cf-Access-Jwt-Assertion` inside the Worker
- verify authenticated access with MCP Inspector and ChatGPT

### Phase 2 — pCloud OAuth — complete for developer instance

- configure the developer's pCloud application credentials
- complete OAuth
- store the pCloud access token as a Cloudflare secret
- configure the regional pCloud API host

### Phase 3 — basic pCloud read access — complete

- implement `list_folder`
- retrieve the pCloud root through ChatGPT
- add optional scoped virtual root with `PCLOUD_ROOT_PATH`

### Phase 4 — metadata search — complete

- implement `search_files`
- recursively search file/folder names and virtual paths beneath the scoped root
- validate behavior and performance against a real pCloud tree
- confirm MCP clients can discover and invoke the added search tool after refreshing the connector/tool metadata

### Phase 5 — file metadata and reading — implementation complete, integration validation pending

- implement `get_file_info`
- implement `read_file`
- add file type and size limits
- enforce the same virtual-root boundary for both tools

### Later

- indexing/caching only if real usage shows it is needed
- investigate shared OAuth only if onboarding friction becomes worth solving
