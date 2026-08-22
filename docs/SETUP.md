# Self-hosting setup

This guide deploys the Worker into your own Cloudflare account and connects it to your own pCloud account. You are responsible for the Cloudflare Access policy and the pCloud subtree exposed to MCP clients.

External dashboards and client capabilities change over time. Use the linked vendor documentation for current UI details; this guide documents the configuration expected by this repository.

## Prerequisites

- Node.js 22.18.0 or later on a supported release line (`^22.18.0 || >=24.11.0`) and a compatible npm release. CI validates the exact 22.18.0 minimum; no exact npm version is required. Dependency versions are recorded in `package-lock.json`.
- A Cloudflare account with Workers and a Cloudflare Zero Trust organization with an identity provider.
- A pCloud account and a pCloud application registered through [pCloud My Apps](https://docs.pcloud.com/my_apps/).
- An MCP client that can connect to a remote HTTP MCP server and complete OAuth. For ChatGPT, confirm that your plan and workspace allow custom MCP apps and developer mode in the [current OpenAI documentation](https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt-beta).

Cloudflare documents the currently supported Node.js releases for Wrangler in its [installation guide](https://developers.cloudflare.com/workers/wrangler/install-and-update/). The installed Wrangler version is a project dependency; do not replace it with an unreviewed global version.

## 1. Prepare the repository

```powershell
git clone https://github.com/yora0418/pcloud-mcp-cloudflare.git
Set-Location pcloud-mcp-cloudflare
npm.cmd ci
npm.cmd test
npm.cmd run typecheck
npm.cmd run deploy -- --dry-run
```

On shells that do not require the Windows `.cmd` shim, use `npm` in place of `npm.cmd`.

Authenticate Wrangler without placing Cloudflare credentials in the repository:

```powershell
npx.cmd wrangler login
```

## 2. Obtain a pCloud OAuth access token

1. Register an application in [pCloud My Apps](https://docs.pcloud.com/my_apps/) and keep its client ID and client secret private.
2. Follow pCloud's [OAuth authorization documentation](https://docs.pcloud.com/methods/oauth_2.0/authorize.html). For a server deployment, pCloud recommends the authorization-code flow (`response_type=code`). Use an exact registered redirect URI and a random `state` value. If no redirect URI is supplied for the code flow, pCloud may display the authorization code instead.
3. Exchange the short-lived code using pCloud's [`oauth2_token` method](https://docs.pcloud.com/methods/oauth_2.0/oauth2_token.html) from a trusted local environment. Send the client ID, client secret, and code in the request body rather than publishing them in a URL, script, shell history, or issue.
4. Record the API `hostname` associated with the authorized account. pCloud uses `api.pcloud.com` for US accounts and `eapi.pcloud.com` for EU accounts; the authorization response identifies the correct host for subsequent calls.
5. Retain only the resulting access token for Worker configuration. This Worker does not need the pCloud client secret at runtime.

Never commit an authorization code, client secret, or access token. A pCloud access token is not inherently limited to the read-only calls implemented by this Worker, so protect it as a high-value credential.

## 3. Create the Worker endpoint

Deploy once to create the Worker and obtain its HTTPS hostname:

```powershell
npm.cmd run deploy
```

Until valid Cloudflare Access configuration is present, the Worker fails closed with a forbidden response. Do not connect an MCP client until the following Access and runtime configuration steps are complete.

If you use a custom domain or route instead of the generated Workers hostname, complete that Cloudflare configuration before creating the Access application. Protect the exact hostname that will serve the MCP endpoint.

## 4. Protect the Worker with Cloudflare Access

1. In Cloudflare Zero Trust, create an Access application for the Worker. When the dashboard offers direct Worker selection, use it so Access covers every route; Cloudflare describes this as the safest and most straightforward option in its [application type guide](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/choose-application-type/). For a `workers.dev` endpoint, the Worker dashboard also provides an [Enable Cloudflare Access](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/#manage-access-to-workersdev) action. Otherwise, protect the exact custom hostname.
2. Add an Allow policy limited to the identities that should be able to read the exposed pCloud content. Access applications deny unmatched users by default.
3. Enable **Managed OAuth** so non-browser MCP clients can authenticate through an authorization-code flow. Follow Cloudflare's [Managed OAuth guide](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/), including redirect-client restrictions appropriate for your MCP client.
4. Copy the Cloudflare Zero Trust team domain and the application's Audience (AUD) tag. Cloudflare documents where to find the AUD tag in its [JWT validation guide](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/).
5. Protect the entire Worker hostname, including `/mcp`, and do not create an unprotected alternate route to the same Worker. The tracked Wrangler configuration explicitly disables both versioned and aliased Preview URLs while retaining the normal production `workers.dev` endpoint.

The Worker independently validates the `Cf-Access-Jwt-Assertion` signature, issuer, audience, and RS256 algorithm after Cloudflare Access allows the request.

## 5. Configure Worker variables and the secret

Configure the following under the Worker's **Settings > Variables and Secrets**. Keep real deployment values out of `wrangler.jsonc` and all tracked files.

| Name | Type | Required value |
| --- | --- | --- |
| `TEAM_DOMAIN` | Variable | Canonical team origin such as `https://<team-name>.cloudflareaccess.com`; no custom port, path, query, or fragment |
| `POLICY_AUD` | Variable | Audience tag of the Access application protecting this Worker |
| `PCLOUD_API_HOST` | Variable | Exactly `api.pcloud.com` or `eapi.pcloud.com`, matching the OAuth result |
| `PCLOUD_ROOT_PATH` | Variable | Optional absolute pCloud folder to expose as MCP `/`; omit it only if the entire pCloud root may be read by the client |
| `PCLOUD_SEARCH_MAX_FOLDER_CALLS` | Variable | Optional canonical integer from `1` to `1024`; defaults to `45` complete-search folder listings |
| `PCLOUD_ACCESS_TOKEN` | Secret | The pCloud OAuth access token |

For example, set `PCLOUD_ROOT_PATH` to a dedicated folder containing only data the connected client may receive. The value is used exactly as supplied, including spaces in filename segments; do not add formatting whitespace. Empty segments, `.` or `..` segments, backslashes, control characters, unpaired UTF-16 surrogates, and overlong segments are rejected. Read-only behavior prevents file mutation but does not prevent disclosure of readable content.

The default search limit leaves headroom below the Workers Free external-subrequest ceiling. Prefer narrower `search_files` paths for large trees. Increase `PCLOUD_SEARCH_MAX_FOLDER_CALLS` only when the selected Workers plan provides enough per-request external-subrequest allowance; malformed or out-of-range values make searches fail closed.

You can enter the pCloud token interactively without placing it on a command line:

```powershell
npx.cmd wrangler secret put PCLOUD_ACCESS_TOKEN
```

The tracked Wrangler configuration has `keep_vars` enabled so normal deployments preserve dashboard-managed variables and secrets.

It also defines the non-secret `MCP_RATE_LIMITER` binding with a default of 120 authenticated MCP POST requests per 60 seconds per verified Access principal. Its `namespace_id` is a positive-integer string required by Cloudflare. If namespace `1001` is already used by another rate-limit binding in the same Cloudflare account, select a different unused positive integer before the first deployment; bindings sharing a namespace also share counters for matching keys. Rate limiting is approximate and local to each Cloudflare location. A missing, invalid, or unavailable binding causes authenticated MCP POST requests to fail closed with HTTP 503.

## 6. Deploy and verify

After Access, variables, and the secret are configured, validate and deploy:

```powershell
npm.cmd ci
npm.cmd test
npm.cmd run typecheck
npm.cmd run deploy -- --dry-run
npm.cmd run deploy
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

## Updating

Review upstream changes, then update from a clean checkout:

```powershell
git switch main
git pull --ff-only
npm.cmd ci
npm.cmd test
npm.cmd run typecheck
npm.cmd run deploy -- --dry-run
npm.cmd run deploy
```

Recheck the scoped root and one harmless tool call after deployment. Normal deployment does not require re-entering dashboard variables because `keep_vars` is enabled.

## Rollback

Cloudflare Workers retains versions and deployments. Inspect the current deployment and recent versions before selecting a known-good version:

```powershell
npx.cmd wrangler deployments status
npx.cmd wrangler versions list
npx.cmd wrangler rollback VERSION_ID
```

Replace `VERSION_ID` with the selected known-good version. Follow Cloudflare's [rollback documentation](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/) for current behavior and limitations. After rollback, verify Access authentication, runtime configuration, and the virtual-root scope.
