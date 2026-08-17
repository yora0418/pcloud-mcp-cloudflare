# Design Notes

This document records the initial design decisions for `pcloud-mcp-cloudflare`.

## Purpose

Provide a serverless, read-only remote MCP interface to pCloud so MCP-compatible AI clients can find and read a user's own files without requiring a dedicated server.

## Architecture

```text
MCP-compatible AI client
        |
        | Remote MCP
        v
Cloudflare Worker
        |
        | pCloud OAuth / API
        v
pCloud
```

The public repository contains the software. Each user deploys their own Worker instance and supplies their own credentials.

## Initial security boundary

The initial version is intentionally read-only.

Allowed capabilities:

- list folders
- search file metadata / paths
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

## Initial pCloud authentication model

For the first release, every user registers their own pCloud application and stores their own pCloud credentials in their own Cloudflare environment.

Goals of this choice:

- no user access tokens are stored by YoraLAB
- no YoraLAB credential needs to be distributed to self-hosted instances
- the initial implementation stays simple
- OAuth onboarding work is deferred until there is evidence that users actually need it

### Future possibility: shared OAuth application

It may be possible to use a shared YoraLAB pCloud OAuth application so users would not need to register their own pCloud app.

This has **not** been investigated in enough depth for the initial release. Open questions include:

- how to use a shared OAuth client safely with independently hosted Cloudflare Workers
- whether Code Flow, Token/Implicit Flow, or an OAuth broker is most appropriate
- how redirect URIs should work across self-hosted deployments
- how to avoid distributing a shared `client_secret`

This is deliberately deferred. Contributions and experiments are welcome. If someone implements this in a fork, publishing the source and contributing the work upstream is encouraged.

## MCP tool design

The MCP surface should be small and task-oriented rather than mirroring the full pCloud API.

Initial tools:

### `list_folder`

List entries in a folder. Support root access and folder identifiers/paths as appropriate.

### `search_files`

Search files by metadata such as name and path. The first version does not require full-text indexing.

Possible future evolution:

- cached metadata index
- Cloudflare KV / D1 backed index
- incremental updates using pCloud change information
- full-text indexing for supported document formats

### `get_file_info`

Return metadata for a specific file.

### `read_file`

Retrieve supported file contents while applying practical size/type limits.

## pCloud-specific implementation notes

Implementation must account for pCloud's API/OAuth behavior, including regional API host handling where required.

Existing open-source pCloud MCP implementations may be used as references for pCloud-specific API behavior, but this project is a new Cloudflare Workers-oriented implementation rather than a fork of a server-based MCP implementation.

## Cloudflare design

The project should target Cloudflare Workers directly rather than requiring a long-running server or container.

Planned characteristics:

- stateless remote MCP endpoint where practical
- secrets stored using Cloudflare's secret facilities, never committed to Git
- minimal dependencies
- no dedicated VPS / home server requirement

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

The developer's own production instance should likewise run in the developer's personal Cloudflare account rather than the YoraLAB public-service account.

## Repository visibility

Development begins in a private repository. The repository is intended to become public once the initial implementation is functional and reviewed for accidental credential or personal-data exposure.

## License

AGPL-3.0 is the current leading candidate, but the license has not been finalized yet.

Rationale under consideration: if modified versions are offered to other users as a network service, improvements should ideally remain available as source code. Final license selection should be made before public release.

## Development phases

### Phase 0 — MCP skeleton

- create the Cloudflare Workers project
- expose a minimal remote MCP endpoint
- add a harmless test tool such as `hello`
- verify with an MCP inspector/client

### Phase 1 — AI client connectivity

- connect ChatGPT or another compatible remote MCP client
- verify that the test tool can be discovered and called

### Phase 2 — pCloud OAuth

- configure the developer's pCloud application credentials
- complete OAuth
- securely persist the resulting credentials/token needed by the Worker

### Phase 3 — basic pCloud read access

- implement `list_folder`
- retrieve the pCloud root through MCP

### Phase 4 — metadata search

- implement `search_files`
- begin with file/folder metadata and path search

### Phase 5 — file reading

- implement `get_file_info`
- implement `read_file`
- add file type and size limits

### Later

- indexing/caching only if real usage shows it is needed
- investigate shared OAuth only if onboarding friction becomes worth solving
