# pCloud MCP for Cloudflare Workers

**English** | [日本語](README.ja.md)

A self-hosted, read-only remote MCP server that lets MCP-compatible AI clients such as ChatGPT access files stored in your pCloud account through Cloudflare Workers.

<sub>v0.1.0 — early release. Interfaces, limits, setup requirements, and client compatibility may change.</sub>

## What it does

- Browse folders and search file/folder names and virtual paths.
- Read normalized file metadata and supported UTF-8 text files.
- Return PNG/JPEG images and DOCX/XLSX/PPTX files to compatible MCP clients.
- Restrict the MCP-visible area to a selected pCloud subtree with `PCLOUD_ROOT_PATH`.

**Not supported:** upload, delete, move, rename, folder creation, sharing, full-text content search, or PDF retrieval.

### Supported content

| Content | Current support |
| --- | --- |
| Text | Supported text formats, strict UTF-8; 256 KiB default, up to 1 MiB |
| Images | PNG / JPEG; up to 5 MiB source file |
| Office | DOCX / XLSX / PPTX; up to 1 MiB source file |

Large folder trees can exceed bounded search limits. Use a narrower search path when necessary; incomplete partial search results are not returned.

<details>
<summary>Current MCP tools</summary>

`hello`, `list_folder`, `search_files`, `get_file_info`, `read_file`, `get_image_content`, `get_office_content`

</details>

## Important

> [!WARNING]
> **Use this software at your own risk.** It is provided **AS IS**, without warranty of any kind, and may contain bugs, security vulnerabilities, or incorrect assumptions. To the maximum extent permitted by applicable law, the authors and contributors are not liable for data loss, data disclosure, credential compromise, service interruption, account problems, financial loss, or other damages arising from its use or inability to use it.
>
> **Read-only does not mean private.** An authorized MCP client can receive metadata and file contents from the pCloud scope you expose. Use `PCLOUD_ROOT_PATH` to expose only content you are willing to disclose to every identity and MCP client allowed by your Cloudflare Access policy.

Treat the pCloud access token as a high-value credential. Never commit it, publish it, or paste it into an issue, screenshot, log, or AI chat.

<sub>This project is developed substantially with AI-assisted coding. Tests, reviews, or audits do not guarantee correctness or security. The developer does not collect user data through this software; pCloud, Cloudflare, and the MCP client you connect are separate services.</sub>

See the [AGPL-3.0-only license](LICENSE) for the full warranty disclaimer and limitation of liability, and [SECURITY.md](SECURITY.md) for the security model and vulnerability-reporting process.

## Getting started

### AI-assisted setup

You can give this repository to an AI coding assistant and have it guide the self-hosting process from the existing setup documentation.

```text
Help me self-host this repository.
Read README.md, docs/SETUP.md, and SECURITY.md first.
Follow the documented setup and do not ask me to paste secrets into chat or commit them.
Stop before unrelated or destructive changes.
```

### Manual setup

Follow [docs/SETUP.md](docs/SETUP.md) for the manual deployment and MCP-client connection steps.

Technical setup and design documentation is currently maintained in English only.

## Documentation

**For users:** [Setup](docs/SETUP.md) · [Security](SECURITY.md)

**For developers:** [Design](docs/DESIGN.md) · [Development](docs/DEVELOPMENT.md) · [Agent instructions](AGENTS.md)

## License and project

Licensed under the [GNU Affero General Public License v3.0 only](LICENSE).

Developed by **YoraLAB**. This is an independent open-source project and is not an official product of pCloud, Cloudflare, OpenAI, or other MCP client vendors.
