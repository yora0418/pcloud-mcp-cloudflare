# pCloud MCP for Cloudflare Workers

**English** | [日本語](README.ja.md)

A self-hosted, read-only remote MCP server that lets MCP-compatible AI clients such as ChatGPT access files stored in your pCloud account through Cloudflare Workers.

This project is intended for people who want to connect their own pCloud account to an MCP client without running a dedicated server. Each user deploys their own Worker and supplies their own pCloud and Cloudflare configuration. YoraLAB does not receive or store users' pCloud access tokens.

## What you can do

- Browse folders exposed through the MCP virtual root.
- Search file and folder names and virtual paths.
- Inspect normalized file metadata.
- Read supported UTF-8 text files.
- Return PNG and JPEG images as MCP image content.
- Return DOCX, XLSX, and PPTX files as embedded MCP resources.
- Restrict the MCP-visible area to a selected pCloud subtree with `PCLOUD_ROOT_PATH`.

The current server does **not** provide upload, delete, move, rename, folder creation, sharing, or other write operations.

## Important: use at your own risk

> [!WARNING]
> **This software is provided "AS IS", without warranty of any kind. Use it entirely at your own risk. To the maximum extent permitted by applicable law, the authors and contributors are not liable for data loss, data disclosure, credential compromise, service interruption, account problems, financial loss, or other damages arising from use of, or inability to use, this software.**

This project is developed substantially with AI-assisted coding, including workflows commonly described as vibe coding. Human review, automated tests, audits, or other validation work may be performed during development, but **none of these constitute a warranty or a guarantee of correctness, security, reliability, fitness for a particular purpose, or suitability for your environment**.

**Read-only does not mean private.** The Worker does not expose pCloud write tools, but an authorized MCP client can receive metadata and file contents from the pCloud scope you expose. Only expose content that you are willing to disclose to every identity and MCP client allowed by your Cloudflare Access policy.

The pCloud access token itself is not limited to the read-only operations implemented by this Worker. Treat it as a high-value credential and never commit it, publish it, or paste it into an issue or public chat.

This is an early project. Interfaces, limits, setup requirements, and client compatibility may change.

Review the full [AGPL-3.0-only license](LICENSE) and the [security policy and threat model](SECURITY.md) before deployment. If this README and the license differ, the license text controls.

## Choose your setup path

### AI-assisted setup

If Cloudflare Workers, OAuth, command-line tools, or MCP configuration are unfamiliar, use an AI coding assistant to guide the setup instead of trying to understand every technical detail first.

Give the assistant access to this repository and ask it to read [the manual setup guide](docs/SETUP.md) and [SECURITY.md](SECURITY.md) before making changes. Keep secrets out of prompts, commits, issues, screenshots, and logs. Enter credentials only through trusted local or provider secret-input mechanisms when instructed.

Suggested prompt:

```text
Help me self-host this pCloud MCP server.
First read README.md, docs/SETUP.md, and SECURITY.md.
Guide me through the setup step by step and explain only what I need to do.
Do not ask me to paste secrets into chat or commit them to the repository.
Do not weaken Cloudflare Access, authentication checks, or the PCLOUD_ROOT_PATH scope boundary.
Stop and explain before any unrelated or destructive change.
```

An AI assistant can reduce the amount of infrastructure knowledge required, but it does not remove the risks described above. You remain responsible for the deployment, credentials, Access policy, and exposed pCloud scope.

### Manual setup

If you are comfortable with Cloudflare Workers, OAuth, and command-line tools, follow the [self-hosting setup guide](docs/SETUP.md).

Technical setup and design documentation is currently maintained in English only.

## How it works

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

Each deployment uses the user's own Cloudflare and pCloud environment. Cloudflare Access is the external authorization boundary, and the Worker also validates the signed Access JWT before allowing pCloud-backed MCP operations.

## Current tools

| Tool | Purpose |
| --- | --- |
| `hello` | Connectivity smoke test |
| `list_folder` | List a virtual folder |
| `search_files` | Search names and virtual paths; metadata only |
| `get_file_info` | Retrieve normalized metadata for an exact virtual file path |
| `read_file` | Read a supported UTF-8 text file |
| `get_image_content` | Return a PNG or JPEG as MCP ImageContent |
| `get_office_content` | Return a DOCX, XLSX, or PPTX as an embedded MCP resource |

## Security model at a glance

- Cloudflare Access protects the Worker endpoint, and the Worker independently validates the Access JWT.
- `PCLOUD_ROOT_PATH` can map a selected pCloud subtree to MCP `/`; use the smallest scope that the connected client needs.
- The MCP tool surface is intentionally read-only and does not expose pCloud write operations.
- Requests, upstream responses, search traversal, content size, and execution time are bounded by application limits.
- Files and metadata retrieved from pCloud are untrusted input. They may contain prompt injection or misleading instructions intended to influence an AI client.
- Do not create alternate Worker routes that bypass Cloudflare Access.

For the complete threat model, credential guidance, and vulnerability-reporting process, see [SECURITY.md](SECURITY.md). Implementation details and exact safety bounds are documented in [docs/DESIGN.md](docs/DESIGN.md).

## User-visible limits

| Capability | Current behavior |
| --- | --- |
| Search | File/folder names and reconstructed virtual paths only; no full-text content search |
| Text | Supported text formats, strict UTF-8; 256 KiB default limit, configurable up to 1 MiB |
| Images | PNG and JPEG; 5 MiB source-file hard limit |
| Office | DOCX, XLSX, and PPTX; 1 MiB source-file hard limit |
| PDF | Not supported by the current MCP tool set |
| Write operations | Not supported |

Large folder trees may exceed bounded search limits. Use a narrower `path` when necessary rather than assuming a partial search result will be returned.

Office files are returned as embedded resources inside tool results. MCP clients must support embedded resource content in tool results to consume them.

## Documentation

- [Self-hosting setup](docs/SETUP.md) — manual deployment and client connection
- [Security policy](SECURITY.md) — threat model, credential handling, and vulnerability reporting
- [Design notes](docs/DESIGN.md) — architecture, security boundaries, tool behavior, and exact implementation limits
- [Development workflow](docs/DEVELOPMENT.md) — contributor and coding-agent workflow
- [AGENTS.md](AGENTS.md) — repository-wide instructions for coding agents

Technical documentation is currently maintained in English.

## License

Licensed under the [GNU Affero General Public License v3.0 only](LICENSE).

The software is distributed without warranty as described in the license. Nothing in this README should be interpreted as a warranty, certification, security guarantee, or promise of fitness for a particular use.

Bug reports and contributions are welcome. For ordinary bugs, open a GitHub Issue without including credentials or private pCloud data. Report potential security vulnerabilities as described in [SECURITY.md](SECURITY.md).

## Project

Developed by **YoraLAB**.

This is an independent open-source project and is not an official product of pCloud, Cloudflare, OpenAI, or other MCP client vendors.
