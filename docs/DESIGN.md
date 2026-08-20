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

The source repository is prepared for public distribution. Each user deploys their own Worker instance and supplies their own credentials and Access configuration.

## Initial security boundary

The initial version is intentionally read-only.

Allowed capabilities:

- list folders
- search file/folder metadata and virtual paths
- retrieve file metadata
- read supported file contents
- retrieve supported image content
- retrieve supported Office content

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
- `TEAM_DOMAIN` is an HTTPS `<team-name>.cloudflareaccess.com` origin without userinfo, a custom port, path, query, or fragment
- the JWT signing algorithm is RS256, matching Cloudflare Access signing keys
- the issuer against the deployment's Cloudflare One team domain
- the audience against the deployment's Access Application Audience (AUD) tag

These deployment-specific values are provided as Worker environment variables:

- `TEAM_DOMAIN`
- `POLICY_AUD`

They are configuration values rather than application secrets, but are intentionally not committed as developer-specific values because each self-hosted deployment has its own Access configuration.

Cloudflare Managed OAuth is used so compatible non-browser MCP clients can authenticate through Access. The client receives an opaque OAuth token; Cloudflare resolves it at the edge and forwards the signed Access assertion to the Worker.

After successful JWT verification, authenticated `/mcp` POST requests are rate-limited through the `MCP_RATE_LIMITER` Workers binding before request-body parsing or MCP SDK dispatch. The key uses a non-empty verified JWT `sub`, otherwise verified `common_name`, otherwise a shared conservative fallback. Email is not used. The default is 120 requests per 60 seconds per principal; Cloudflare rate limits are approximate and local to a Cloudflare location. Missing, invalid, or failed enforcement returns HTTP 503 rather than bypassing the boundary.

MCP POST bodies pass through an application-level 256 KiB streaming limit before reaching the SDK. Canonical `Content-Length` values above the limit are rejected before buffering, but the Worker always counts streamed bytes and cancels on actual overflow. It reconstructs the Request from only the bounded bytes. GET, HEAD, and other bodyless endpoint behavior remains unchanged.

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
- all current and future path-based tools use the same path-resolution boundary

If `PCLOUD_ROOT_PATH` is unset, `/` means the real pCloud root for backward compatibility and general self-hosted use.

## MCP tool design

The MCP surface should be small and task-oriented rather than mirroring the full pCloud API.

Every tool advertises MCP annotations that describe it as read-only, non-destructive, and idempotent. pCloud-backed tools retain the open-world hint because they retrieve externally stored metadata or content; the local `hello` check is closed-world. These hints support client UX and risk assessment but are not security controls. The Worker enforces the actual read-only and virtual-root boundaries.

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

pCloud's documented API does not expose a dedicated general filename search method. The implementation therefore calls `listfolder` without recursive mode for one folder at a time and traverses the tree iteratively in the Worker. Traversal is path-based: response-derived folder names are validated and joined beneath the already-resolved physical and virtual parent paths. Response-derived or caller-supplied folder IDs are not used, so traversal cannot bypass the configured virtual root through an ID.

Every pCloud folder response is read through the existing 4 MiB streamed hard limit before strict UTF-8 decoding and JSON parsing, so a large tree is never buffered as one JSON document. The smaller `getfilelink` response retains its separate 64 KiB limit. `search_files` scans at most 10,000 entries, descends at most 64 levels, and defaults to at most 45 folder/API calls. The optional `PCLOUD_SEARCH_MAX_FOLDER_CALLS` deployment variable accepts only a canonical integer from 1 to 1,024. The conservative default leaves headroom below the Workers Free external-subrequest ceiling; increasing it requires a Workers plan with sufficient per-request allowance. Exceeding any response or traversal bound while work remains returns an explicit error without partial search results and advises a narrower search path. A traversal that empties its folder queue exactly at the effective limit succeeds. Malformed JSON and JSON size overflow are reported separately without exposing response content.

This is **not** full-text content search.

Possible future evolution:

- cached metadata index
- Cloudflare KV / D1 backed index
- incremental indexing or cache refresh using the pCloud `diff` API for large trees
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
- requires the downloaded byte length to exactly match metadata, then rejects folders, binary formats, unsupported types, non-UTF-8 text, oversized files, and partial or inconsistent reads; support for additional text encodings may be added later
- does not expose physical paths, temporary download URLs, or caller-supplied file-ID access

### `get_image_content`

Retrieve a supported image by exact virtual path and return it directly as MCP ImageContent. The initial implementation:

- supports canonical `image/png` and `image/jpeg` metadata
- permits `.png`, `.jpg`, and `.jpeg` fallback only when pCloud reports a generic MIME type
- verifies PNG or JPEG binary signatures after download and rejects mismatches
- enforces a 5 MiB source-file hard limit independently of the `read_file` text limits
- uses the same `getfilelink`, HTTPS `*.pcloud.com` content-host validation, manual redirect policy, streaming byte bound, and virtual-root boundary as `read_file`
- does not expose physical paths, temporary download URLs, file contents in logs, or caller-supplied file-ID access

### `get_office_content`

Retrieve an OOXML Office file by exact virtual path and return its original bytes as an MCP embedded binary resource. The initial implementation:

- supports `.docx`, `.xlsx`, and `.pptx` with their format-specific MIME types
- accepts the matching canonical MIME type, or a generic/ZIP container MIME when the extension is supported
- enforces a 1 MiB source-file hard limit through metadata, `Content-Length`, streaming byte count, and exact metadata/body-size checks
- verifies the standard ZIP local-header signature after download to reject obvious non-ZIP content
- intentionally does not inspect ZIP metadata or entries, decompress data, validate XML or package parts, or act as an Office integrity checker; Office validity and content interpretation belong to the MCP client
- returns only the original base64-encoded package bytes with the canonical Office MIME type and an opaque custom resource URI; ZIP entries and XML are not returned separately
- uses the same `getfilelink`, HTTPS `*.pcloud.com` content-host validation, manual redirect policy, streaming byte bound, and virtual-root boundary as the existing content tools
- does not support PDF, legacy `.doc`/`.xls`/`.ppt`, macro-enabled Office extensions, or arbitrary ZIP paths
- integration validation confirmed ChatGPT native Office handling for DOCX, XLSX, and PPTX through the deployed MCP; no quantitative parity with direct file uploads is claimed

## pCloud-specific implementation notes

Implementation must account for pCloud's API/OAuth behavior, including regional API host handling where required.

The pCloud root folder has folder ID `0`, but scoped deployments intentionally avoid treating that physical root as the MCP root.

`search_files` deliberately avoids pCloud recursive `listfolder` responses. A production diagnostic measured an unfiltered recursive whole-tree response at more than 32 MiB, so that strategy is unsuitable for the bounded v0.1 search path. The Worker instead reconstructs paths from validated names while requesting each folder non-recursively, keeping every JSON response independently bounded and reapplying the scoped parent path at each step.

pCloud metadata may contain 64-bit identifiers, hashes, and file sizes that exceed JavaScript's safe integer range. The Worker preserves exact decimal strings, converts only safe integer IDs to strings, and may recover file/folder IDs from pCloud's canonical string `id` field. It never exposes a rounded unsafe numeric ID, hash, or size. Content tools additionally require a size that can be represented as a safe non-negative integer before downloading bytes, so this correctness rule does not weaken their existing limits.

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
- preview URLs explicitly disabled while the normal production `workers.dev` route remains available for Access protection

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

## Repository visibility

The repository remains private while the v0.1 release candidate undergoes final external review. Publication, tagging, and the first GitHub Release are separate release steps.

## License

The project is licensed under `AGPL-3.0-only`. The complete license text is in the repository root `LICENSE` file.

## v0.1 release packaging

- application and MCP server version: `0.1.0`
- distribution: GitHub source repository and GitHub-generated source archives
- npm publication: disabled through `"private": true`
- reproducibility: npm dependencies are recorded in the tracked `package-lock.json`
- validation: credential-free GitHub Actions runs the mocked tests, TypeScript check, and Wrangler deployment dry run
- publication status: repository visibility, Git tag, and GitHub Release remain pending separate final release steps

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

### Phase 2 — pCloud OAuth — complete

- configure pCloud application credentials for a self-hosted deployment
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

### Phase 5 — file metadata and reading — complete

- implement `get_file_info`
- implement `read_file`
- add file type and size limits
- enforce the same virtual-root boundary for both tools
- validate metadata and bounded UTF-8 reading against a real pCloud account through a deployed Cloudflare Worker and ChatGPT MCP

### Phase 6 — image content — complete

- implement `get_image_content` for PNG and JPEG files
- return bounded image bytes directly as MCP ImageContent
- enforce metadata, binary-signature, source-size, and virtual-root checks
- validate PNG and JPEG ImageContent delivery through a deployed Worker and ChatGPT Vision

### Phase 7 — Office content — complete

- implement `get_office_content` for DOCX, XLSX, and PPTX files
- return the original bounded package bytes as an MCP embedded binary resource
- validate metadata, source size, and a lightweight ZIP signature without inspecting package internals
- validate native Office handling for all three supported formats through a deployed Worker and ChatGPT MCP, including document structure and text, slide text/tables/values/layout, and workbook cells/formulas/results/cross-sheet references/charts
- treat direct-upload parity as unmeasured rather than claiming equivalence

### Phase 8 — v0.1 public release readiness — in progress

#### Phase 8.1 — security hardening — complete

- preserve exact pCloud 64-bit metadata without exposing rounded unsafe numeric identifiers or sizes
- restrict the Cloudflare Access trust anchor to canonical HTTPS team domains and RS256 JWT verification
- declare read-only MCP tool annotations and add tracked security and regression tests
- validate the hardened Access authentication and existing pCloud metadata/content paths through a production Worker and ChatGPT MCP

#### Phase 8.2 — release packaging and documentation — complete

- set the release-candidate identity to version `0.1.0` under `AGPL-3.0-only`
- track the npm lockfile for reproducible clean installs without publishing an npm package
- document third-party self-hosting, security reporting, and release boundaries
- add credential-free CI for tests, type checking, and a Wrangler deployment dry run
- keep repository publication, tags, and GitHub Releases pending final external review

#### Phase 8.4 — external audit remediation — implementation and production integration complete, independent re-audit pending

- fail closed on pCloud API redirects and bound pCloud JSON responses
- enforce bounded MCP ingress and per-principal authenticated POST rate limiting before SDK dispatch
- make folder-by-folder metadata search iterative and bounded, and require exact text metadata/body size consistency
- validate the default 45-call search bound in production: complete bounded subtrees succeed, while larger trees fail explicitly without partial results before an opaque platform subrequest failure
- disable Worker Preview URLs explicitly and pin CI actions to immutable release commits
- retain the existing embedded Office resource transport without adding standalone resource APIs

### Later

- indexing/caching only if real usage shows it is needed
- investigate shared OAuth only if onboarding friction becomes worth solving
