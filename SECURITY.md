# Security Policy

## Security report scope

Security reports are accepted for the current `0.1.x` line. Earlier development versions are unsupported.

| Version | Security reports |
| --- | --- |
| `0.1.x` | In scope |
| Earlier development versions | Out of scope |

Being in scope for security reports does not create a warranty, support obligation, or guarantee that a fix, response, or release will be provided within any particular time frame. The software remains provided without warranty under the [AGPL-3.0-only license](LICENSE).

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
- Authenticated `/mcp` POST bodies are limited to 256 KiB before MCP SDK dispatch, and unsupported top-level JSON-RPC batches are rejected before dispatch. A Cloudflare Rate Limiting binding applies 120 requests per 60 seconds per verified Access principal; it is an approximate location-local abuse control, not exact accounting. Missing or failed rate-limit enforcement fails closed.
- Bearer-authenticated pCloud API requests use bounded POST parameters and never follow redirects. Temporary content requests also use HTTPS-only validated pCloud hosts, bounded final URLs, manual redirect handling, and explicit application timeouts. Search additionally has a fixed aggregate upstream-JSON budget, while every tool has an overall deadline and propagates client disconnects without exposing abort reasons or upstream targets.

## Observability and sensitive-data handling

The tracked Worker configuration enables invocation logs and disables Workers Traces. Sampling and other operational observability details are documented in `docs/SETUP.md` and `docs/DESIGN.md` rather than duplicated here.

Application logs must not contain credentials, physical pCloud paths, temporary content URLs, filenames, file bytes, or extracted content. Treat temporary pCloud content URLs as credentials while they are valid, and keep pCloud access tokens and other secrets in Cloudflare's secret facilities rather than tracked configuration.

A self-hoster who changes the tracked observability settings is responsible for reviewing the resulting retention, access, and disclosure risks before enabling broader logging, traces, or other telemetry.

See the [self-hosting setup guide](docs/SETUP.md) for configuration details.
