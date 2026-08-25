# Self-hosting setup

This is the manual technical setup path for deploying the Worker into your own Cloudflare account and connecting it to your own pCloud account. You are responsible for the Cloudflare Access policy and the pCloud subtree exposed to MCP clients.

If you prefer AI-assisted setup, return to the [README](../README.md) and use the AI-assisted setup path.

External dashboards and client capabilities change over time. Use the linked vendor documentation for current UI details; this guide documents the configuration expected by this repository rather than attempting to mirror every dashboard screen.

## Command notation

Command examples use the cross-platform `npm`, `npx`, and `cd` forms. They are intended for macOS, Linux, WSL, and normal Windows PowerShell environments.

Some Windows PowerShell configurations block the `npm.ps1` or `npx.ps1` shim through execution policy. If that happens, use the `.cmd` form instead:

| Command shown in this guide | Windows PowerShell fallback |
| --- | --- |
| `npm` | `npm.cmd` |
| `npx` | `npx.cmd` |
| `cd` | `cd` or `Set-Location` |

The project is not Windows-only.

## Prerequisites

- Git.
- Node.js on a supported LTS line (`^22.18.0 || ^24.11.0`) and a compatible npm release. CI validates the exact 22.18.0 and 24.11.0 minimums; no exact npm version is required. Dependency versions are recorded in `package-lock.json`.
- A Cloudflare account with Workers and Zero Trust / Access enabled. If Zero Trust is not enabled yet, complete the initial Zero Trust setup first.
- A pCloud account and a pCloud application registered through [pCloud My Apps](https://docs.pcloud.com/my_apps/).
- An MCP client that can connect to a remote HTTP MCP server and complete OAuth. For ChatGPT, confirm that your plan and workspace allow custom MCP apps and developer mode in the [current OpenAI documentation](https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt-beta).

Cloudflare documents the currently supported Node.js releases for Wrangler in its [installation guide](https://developers.cloudflare.com/workers/wrangler/install-and-update/). The installed Wrangler version is a project dependency; do not replace it with an unreviewed global version.

## 1. Prepare the repository

```shell
git clone https://github.com/yora0418/pcloud-mcp-cloudflare.git
cd pcloud-mcp-cloudflare
npm ci
npm test
npm run typecheck
npm run deploy -- --dry-run
```

Authenticate Wrangler without placing Cloudflare credentials in the repository:

```shell
npx wrangler login
```

## 2. Obtain a pCloud OAuth access token

1. Register an application in [pCloud My Apps](https://docs.pcloud.com/my_apps/) and keep its client ID and client secret private.
2. Follow pCloud's [OAuth authorization documentation](https://docs.pcloud.com/methods/oauth_2.0/authorize.html). For a server deployment, pCloud recommends the authorization-code flow (`response_type=code`). Use an exact registered redirect URI and a random `state` value. If no redirect URI is supplied for the code flow, pCloud may display the authorization code instead.
3. Record both the returned authorization `code` and the returned API `hostname`. pCloud uses `api.pcloud.com` for US accounts and `eapi.pcloud.com` for EU accounts. The authorization response identifies the correct host, and subsequent API calls must use that host.
4. Exchange the short-lived code through `https://<hostname>/oauth2_token` from a trusted local environment, using the hostname returned by the authorization step. Follow pCloud's [`oauth2_token` method](https://docs.pcloud.com/methods/oauth_2.0/oauth2_token.html). Send the client ID, client secret, and code in the request body rather than publishing them in a URL, script, shell history, issue, or AI prompt.
5. Retain the resulting access token for Worker configuration and use the same returned hostname as `PCLOUD_API_HOST`. This Worker does not need the pCloud client secret at runtime.

Never commit an authorization code, client secret, or access token. A pCloud access token is not inherently limited to the read-only calls implemented by this Worker, so protect it as a high-value credential.

## 3. Create the Worker endpoint

The tracked `wrangler.jsonc` defines an `MCP_RATE_LIMITER` binding with the default `namespace_id` value `1001`. Cloudflare requires this to be a positive-integer string. If the same Cloudflare account already uses namespace `1001` for another rate-limit binding, change this value in your local `wrangler.jsonc` to another unused positive integer before the first deployment. If Wrangler reports a rate-limit binding or namespace conflict during deployment, this is the first setting to check.

Deploy once to create the Worker and obtain its HTTPS hostname:

```shell
npm run deploy
```

After a successful deployment, Wrangler prints the deployed Worker URL in the terminal output. The Worker hostname is also available from the Worker's overview in the Cloudflare dashboard. Dashboard labels can change, so use Cloudflare's current Workers documentation if the location is not obvious.

Until valid Cloudflare Access configuration is present, the Worker fails closed with a forbidden response. Do not connect an MCP client until the following Access and runtime configuration steps are complete.

## 4. Protect the Worker with Cloudflare Access

Cloudflare now supports attaching Access directly to a Worker so the policy follows the Worker across its associated `workers.dev` URL, Custom Domains, and routes. Prefer this Worker-level protection instead of maintaining separate hostname entries when the dashboard offers it.

1. Open the Worker in the Cloudflare dashboard and enable Access for the Worker. Follow Cloudflare's current [Workers Access guide](https://developers.cloudflare.com/workers/configuration/cloudflare-access/). Protect production traffic and use an Allow policy limited to the identities that should be able to read the exposed pCloud content.
2. Confirm in Zero Trust that the generated Access application protects this Worker. If you intentionally use hostname-level Access instead, protect every hostname or route that can reach this Worker; do not leave an alternate public route.
3. Enable **Managed OAuth** on the Access application so compatible non-browser MCP clients can authenticate through an authorization-code flow. Follow Cloudflare's [Managed OAuth guide](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/), including redirect-client restrictions appropriate for your MCP client.
4. Copy the Cloudflare Zero Trust team domain and the application's Audience (AUD) tag. Cloudflare documents where to find the AUD tag in its [JWT validation guide](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/).
5. Verify that every route used to reach the Worker is protected. The tracked Wrangler configuration explicitly disables versioned and aliased Preview URLs; do not create an unprotected alternate route to the same Worker.

The Worker independently validates the `Cf-Access-Jwt-Assertion` signature, issuer, audience, and RS256 algorithm after Cloudflare Access allows the request.

## 5. Configure Worker variables and the secret

Configure the following under the Worker's **Settings > Variables and Secrets**. Keep real deployment values out of `wrangler.jsonc` and all tracked files.

| Name | Type | Required value |
| --- | --- | --- |
| `TEAM_DOMAIN` | Variable | Canonical team origin such as `https://<team-name>.cloudflareaccess.com`; no custom port, path, query, or fragment |
| `POLICY_AUD` | Variable | Audience tag of the Access application protecting this Worker |
| `PCLOUD_API_HOST` | Variable | Exactly `api.pcloud.com` or `eapi.pcloud.com`, matching the hostname returned by pCloud OAuth |
| `PCLOUD_ROOT_PATH` | Variable | Optional absolute pCloud folder to expose as MCP `/`; omit it only if the entire pCloud root may be read by the client |
| `PCLOUD_SEARCH_MAX_FOLDER_CALLS` | Variable | Optional canonical integer from `1` to `1024`; defaults to `45` complete-search folder listings |
| `PCLOUD_ACCESS_TOKEN` | Secret | The pCloud OAuth access token |

For example, set `PCLOUD_ROOT_PATH` to a dedicated folder containing only data the connected client may receive. The value is used exactly as supplied, including spaces in filename segments; do not add formatting whitespace. Empty segments, `.` or `..` segments, backslashes, control characters, unpaired UTF-16 surrogates, segments of 1,024 UTF-8 bytes or more, and complete paths over 16 KiB are rejected. Read-only behavior prevents file mutation but does not prevent disclosure of readable content.

The default search limit leaves headroom below the Workers Free external-subrequest ceiling. Prefer narrower `search_files` paths for large trees. Increase `PCLOUD_SEARCH_MAX_FOLDER_CALLS` only when the selected Workers plan provides enough per-request external-subrequest allowance; malformed or out-of-range values make searches fail closed. Large searches are also subject to Cloudflare Workers plan-level resource limits, so narrowing the search path is preferable to increasing application limits when possible.

The Worker sends bounded pCloud JSON parameters in POST form bodies, rejects final outbound URLs over 16 KiB, and applies explicit timeouts to Access JWKS, pCloud metadata/link, and content requests. Authenticated MCP requests have a fixed 45-second absolute deadline covering bounded body reading and tool execution; client disconnects cancel body reading and pCloud work. `search_files` also has a fixed 16 MiB aggregate folder-listing JSON budget that does not grow with `PCLOUD_SEARCH_MAX_FOLDER_CALLS`. Unscoped `list_folder` accepts only canonical decimal folder IDs of at most 128 digits. These are application safety bounds; no additional deployment variable is required.

Enter the pCloud token interactively without placing it on a command line:

```shell
npx wrangler secret put PCLOUD_ACCESS_TOKEN
```

The tracked Wrangler configuration has `keep_vars` enabled so normal deployments preserve dashboard-managed variables and secrets.

It also enables invocation logs at full sampling and explicitly disables Workers Traces. Keep application logs generic and never log credentials, physical pCloud paths, temporary content URLs, filenames, or file content. Before enabling traces or additional telemetry, review whether automatically captured outbound-request metadata and the selected retention/access policy are appropriate for the exposed pCloud subtree.

The `MCP_RATE_LIMITER` binding defaults to 120 authenticated MCP POST requests per 60 seconds per verified Access principal. Bindings sharing a `namespace_id` also share counters for matching keys, which is why a deployment-specific namespace collision should be resolved before use. Rate limiting is approximate and local to each Cloudflare location. A missing, invalid, or unavailable binding causes authenticated MCP POST requests to fail closed with HTTP 503.

## 6. Deploy and verify

After Access, variables, and the secret are configured, validate and deploy:

```shell
npm ci
npm test
npm run typecheck
npm run deploy -- --dry-run
npm run deploy
```

The remote MCP endpoint is:

```text
https://<your-worker-host>/mcp
```

An unauthenticated request should be rejected by Cloudflare Access. An authenticated request must also pass the Worker's JWT validation.

## 7. Connect ChatGPT or another MCP client

For ChatGPT, follow OpenAI's [current custom MCP app instructions](https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt-beta). Availability, plan requirements, workspace permissions, and labels in the UI may change.

1. Enable developer mode or custom MCP apps if required by the workspace.
2. Create a custom app using `https://<your-worker-host>/mcp` as the remote MCP endpoint.
3. Complete the Cloudflare Managed OAuth login and allow the client to scan the tools.
4. Refresh or recreate the client registration after a server update if the client still shows stale tool metadata.
5. Call `hello` as a connectivity smoke test.
6. Call `list_folder` with path `/` and confirm that it exposes only the intended `PCLOUD_ROOT_PATH` subtree before reading content.

Client-side model behavior and support for image or embedded Office content are client capabilities, not guarantees made by the Worker.

`get_office_content` returns its binary resource inside a tool result. It does not register standalone `resources/list` or `resources/read` APIs, so a general MCP client must support embedded resource content in tool results to consume Office bytes.

## Troubleshooting

### `npm` or `npx` is blocked in Windows PowerShell

If PowerShell reports an execution-policy error involving `npm.ps1` or `npx.ps1`, use `npm.cmd` or `npx.cmd` as described in [Command notation](#command-notation). This does not indicate that the project itself is Windows-specific.

### The first deployment does not show an obvious Worker hostname

A successful `npm run deploy` normally prints the deployed URL in Wrangler's terminal output. You can also open the Worker in the Cloudflare dashboard and inspect its overview/routing information. If deployment itself failed, resolve that failure before looking for a hostname.

### Deployment fails around the rate-limit binding

Check the `MCP_RATE_LIMITER` entry in `wrangler.jsonc`. If its `namespace_id` is already used by another rate-limit binding in the same Cloudflare account, select another unused positive integer and deploy again. Do not remove the binding to make deployment succeed; the application intentionally fails closed when rate limiting is unavailable.

### The Worker returns Forbidden

Before Step 4 is complete, a forbidden response is expected. After configuration, verify that Access is enabled for the Worker or otherwise covers the exact route you are using, that your identity matches an Allow policy, and that `TEAM_DOMAIN` and `POLICY_AUD` correspond to that Access application. Do not solve an authentication problem by exposing an unprotected alternate Worker route.

### OAuth completes but the MCP client cannot discover or use tools

Confirm that the client is configured with the exact `/mcp` endpoint, Cloudflare Managed OAuth is enabled for the protected application, and any redirect-client restrictions allow the MCP client you are using. If the server was updated, refresh or recreate the client registration so stale tool metadata is not reused.

### `hello` works but pCloud-backed tools fail

Check that `PCLOUD_ACCESS_TOKEN` is configured as a Worker secret, `PCLOUD_API_HOST` matches the US/EU hostname returned by pCloud OAuth, and `PCLOUD_ROOT_PATH` refers to a real folder if it is set. If the token was obtained through authorization-code flow, confirm that the code was exchanged on the same regional hostname returned during authorization. Do not paste the token into an Issue, log, screenshot, or AI prompt while troubleshooting.

### `list_folder` at `/` exposes more content than intended

Stop before reading additional files. Set `PCLOUD_ROOT_PATH` to the smallest pCloud subtree that the connected client should be able to receive, then call `list_folder` on `/` again and verify the scope before continuing.

### Search fails on a large folder tree

Use a narrower `path` for `search_files`. Do not assume a bounded search returns partial results. Increase `PCLOUD_SEARCH_MAX_FOLDER_CALLS` only when the selected Workers plan has enough external-subrequest allowance; the separate aggregate response and traversal limits still apply. Cloudflare plan-level resource limits can also stop large searches, so narrowing the path is the preferred first response.

## Updating

Review upstream changes, then update from a clean checkout:

```shell
git switch main
git pull --ff-only
npm ci
npm test
npm run typecheck
npm run deploy -- --dry-run
npm run deploy
```

Recheck the scoped root and one harmless tool call after deployment. Normal deployment does not require re-entering dashboard variables because `keep_vars` is enabled.

## Rollback

Cloudflare Workers retains versions and deployments. Inspect the current deployment and recent versions before selecting a known-good version:

```shell
npx wrangler deployments status
npx wrangler versions list
npx wrangler rollback VERSION_ID
```

Replace `VERSION_ID` with the selected known-good version. Follow Cloudflare's [rollback documentation](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/) for current behavior and limitations. After rollback, verify Access authentication, runtime configuration, and the virtual-root scope.
