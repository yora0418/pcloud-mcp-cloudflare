# Security Policy

## Supported versions

Security fixes are provided for the current `0.1.x` release line.

| Version | Supported |
| --- | --- |
| `0.1.x` | Yes |
| Earlier development versions | No |

## Reporting a vulnerability

Do not post credentials, private pCloud content, exploit details, or other sensitive information in a public GitHub Issue.

Use GitHub's private vulnerability reporting feature when it is available for this repository. If it is unavailable, open a public Issue containing no sensitive details and ask the maintainers to establish a private reporting channel. Include only the affected version and a high-level description until a private channel is available.

For ordinary bugs that do not involve sensitive data or a security boundary, public Issues are welcome.

## If a credential is exposed

Treat an exposed credential as compromised even if it is later deleted from a file or Git history.

- Revoke the affected pCloud access token and issue a replacement.
- Rotate any exposed Cloudflare API token, Access service token, or other secret at its provider.
- Replace the corresponding Worker secret and verify that old credentials no longer work.
- Remove sensitive data from public locations only after revocation; deletion is not a substitute for rotation.

Never include the replacement credential in a report, log, commit, or screenshot.

## Deployment threat model

- The Worker exposes only read-only pCloud operations. The pCloud OAuth token itself does not have a Worker-enforced read-only scope and may authorize additional pCloud operations if used elsewhere.
- Read-only prevents file mutation; it does not prevent an authorized MCP client from receiving file metadata or content.
- Configure `PCLOUD_ROOT_PATH` to the smallest subtree whose complete readable contents may be disclosed to every identity allowed by the Access policy. This project does not implement per-folder denylists.
- Supported file bytes pass from pCloud through the Cloudflare Worker to the MCP client. The Worker enforces type and size limits but the client ultimately receives the selected content.
- Files, metadata, and document text stored in pCloud are untrusted input. They may contain misleading instructions or prompt injection intended to influence an AI client. Review sensitive actions and do not treat retrieved content as trusted policy or authorization.
- Cloudflare Access is the external authorization boundary, and the Worker validates the signed Access JWT as defense in depth. Do not expose an alternate route that bypasses Access.
- Authenticated `/mcp` POST bodies are limited to 256 KiB before MCP SDK dispatch. A Cloudflare Rate Limiting binding applies 120 requests per 60 seconds per verified Access principal; it is an approximate location-local abuse control, not exact accounting. Missing or failed rate-limit enforcement fails closed.
- Bearer-authenticated pCloud API requests never follow redirects. Temporary content requests also use HTTPS-only validated pCloud hosts and manual redirect handling.

See the [self-hosting setup guide](docs/SETUP.md) for configuration details.
