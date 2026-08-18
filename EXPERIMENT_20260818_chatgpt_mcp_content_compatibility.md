# Experiment: ChatGPT MCP content compatibility

**Date:** 2026-08-18  
**Client:** ChatGPT custom MCP app  
**Server:** `pcloud-mcp-cloudflare` on Cloudflare Workers  
**MCP SDK:** `@modelcontextprotocol/server` `2.0.0`  
**Reported to OpenAI:** 2026-08-18 18:32 JST

This document records client-specific interoperability observations discovered while testing MCP content delivery from a real pCloud-backed remote MCP server.

The findings below describe observed ChatGPT behavior on the test date. They are **not** permanent limitations of MCP and should not be treated as guarantees about future ChatGPT behavior or other MCP clients.

No private pCloud paths, credentials, temporary download URLs, or file contents are recorded here.

## Summary

| MCP result type | Test payload | Observed ChatGPT behavior | Result |
| --- | --- | --- | --- |
| `resource_link` | binary file reference | ChatGPT recognized the result as a file/resource and displayed a file-materialization approval flow, but the referenced binary did not become usable model input through the tested client flow | Partial |
| `ImageContent` | small JPEG | image bytes reached the model and were interpreted visually | Success |
| `ImageContent` | PNG, 1,711,377 source bytes | image bytes reached the model; detailed layout, visual features, and small text were recognized | Success |
| embedded binary resource | PDF, approximately 252 KiB | ChatGPT materialized the file, rendered the PDF, and read its page count, headings, and body content | Success |
| embedded binary resource | PDF, approximately 3.9 MiB | materialization entered a repeated approval/error loop and the PDF did not become usable model input | Failed in tested client |

## Conclusion

The experiment produced four useful client-compatibility findings:

1. `ImageContent` was the most reliable tested method for images that the model needed to inspect directly.
2. A `resource_link` reaching the ChatGPT UI did not guarantee that its referenced binary would become available to the model.
3. Inline embedded PDF resources could work end-to-end at small sizes.
4. A larger inline PDF triggered unstable client-side materialization behavior, so no practical PDF size threshold should be assumed from this experiment.

The current production `read_file` behavior remains unchanged: it is a bounded UTF-8 text reader. The PoC tools used for this experiment were intentionally not merged into `main`.

## Test setup

The test server preserved the production project's normal safety boundaries:

- read-only behavior
- path-only access for test tools
- virtual-root validation and traversal rejection
- pCloud API host validation
- validated HTTPS pCloud content hosts
- manual redirect handling
- byte limits checked before and during streaming
- no credentials, physical pCloud paths, temporary download URLs, binary contents, or base64 payloads written to logs or tool text responses

The PoC implementation was kept on an uncommitted local branch while the transport behavior was tested.

## Experiment A — `resource_link`

### Method

A PoC tool returned an MCP `resource_link` backed by a custom opaque MCP resource URI. The resource URI did not contain credentials, a physical pCloud root, or a pCloud temporary download URL.

### Observed behavior

ChatGPT recognized the result as a file-like resource and displayed a file-materialization approval prompt.

After approval, however, the tested ChatGPT flow did not expose a usable `resources/read` path to the model, and the referenced binary did not become model-native image input. The model correctly reported that it had received the resource link but not the image contents.

### Result

**Partial success.** The resource link reached the client UI, but the tested flow did not make the referenced binary usable by the model.

This should not be interpreted as a protocol limitation. MCP resource links allow clients to decide how and when referenced resources are resolved.

## Experiment B — direct `ImageContent`

### Method

A PoC tool retrieved a validated pCloud image and returned its bytes directly as MCP `ImageContent`:

```json
{
  "type": "image",
  "data": "<base64>",
  "mimeType": "image/png"
}
```

The PoC accepted `image/png` and `image/jpeg`, used a 5 MiB source-file safety limit, and reused the project's validated pCloud content-fetch path.

### Test cases

Two real files were tested:

- a small JPEG of approximately 55 KiB
- a PNG with a source size of 1,711,377 bytes

### Observed behavior

Both images reached ChatGPT Vision successfully.

The model described visual details that were unavailable from filenames or metadata. With the larger PNG, the model also recognized detailed text inside the image.

### Result

**Success.** In the tested ChatGPT client, direct MCP `ImageContent` provided usable model-native image input, including for a multi-megabyte encoded tool result.

## Experiment C — embedded PDF resource

### Method

A PoC tool returned the full PDF inline as an MCP embedded resource with base64 `blob` data and `mimeType: application/pdf`.

Conceptually:

```json
{
  "type": "resource",
  "resource": {
    "uri": "pcloud-poc://file/<opaque-token>",
    "mimeType": "application/pdf",
    "blob": "<base64>"
  }
}
```

The PDF bytes were validated before return, including MIME checks, a PDF header check, source-size limits, streaming byte limits, and metadata-size consistency.

### Small PDF control

A PDF of approximately 252 KiB succeeded.

ChatGPT:

- materialized the attachment
- rendered the PDF
- identified the page count
- read the first-page heading
- extracted specific body content

This confirmed that embedded PDF resources can reach ChatGPT's PDF-reading path in at least some cases.

### Larger PDF case

A PDF of approximately 3.9 MiB did not succeed.

The observed sequence was:

1. ChatGPT displayed a file-materialization approval prompt.
2. The user approved materialization.
3. Loading began.
4. ChatGPT displayed a conversation-length-limit error.
5. The materialization approval prompt appeared again.
6. Repeating approval repeated the same cycle.

The same behavior reproduced in a brand-new conversation on its first user message. Accumulated conversation history was therefore not required to trigger the issue.

### Possible explanation

The exact client-side threshold and internal cause were **not determined**.

One plausible factor is the size of the inline base64 payload. Base64 encoding increases binary size by roughly one third, so a PDF around 3.9 MiB becomes an inline encoded payload of roughly 5.2 MiB before JSON/MCP framing overhead.

This may encounter a tool-result, context, or materialization limit in the client. This experiment does **not** establish a specific ChatGPT payload limit, and the displayed conversation-length error may be a generic or misleading error for a different internal limit.

### Result

**Mixed.** Small embedded PDFs worked end-to-end, while the larger test PDF triggered a repeatable client-side materialization loop.

## Reproduction outline for the larger-PDF issue

A minimal reproduction requires a custom remote MCP server that returns an `application/pdf` file inline as an embedded binary resource.

1. Return a PDF of approximately 3.9 MiB source size as base64 `blob` data in an embedded resource.
2. Invoke the tool from a new ChatGPT conversation.
3. Approve the file-materialization prompt.
4. Observe loading begin.
5. Observe a conversation-length-limit error.
6. Observe the materialization approval prompt appear again.
7. Approve again and observe the cycle repeat.

Control case: an otherwise equivalent embedded PDF of approximately 252 KiB materialized and rendered successfully in the same MCP integration.

## Practical guidance for MCP developers

These observations suggest several defensive practices when targeting ChatGPT or other MCP clients:

- treat client rendering/materialization behavior as a capability that should be tested, not assumed from protocol validity alone
- prefer direct `ImageContent` when the model must visually inspect an image and the client supports it
- do not assume that a visible `resource_link` will automatically become model-readable binary content
- keep source-file limits separate from inline/context-result limits
- be conservative with large base64-embedded binary resources unless the target client behavior is known
- distinguish observed client behavior from MCP protocol guarantees in documentation

## Project impact

No production feature was changed as a direct result of these PoCs.

The project's current supported content reader remains bounded UTF-8 text. Future image, PDF, and arbitrary-binary support should be designed separately from the existing text limit and should account for client-specific content handling.

## References

- MCP TypeScript SDK v2: https://ts.sdk.modelcontextprotocol.io/v2/
- OpenAI — Developer mode and MCP apps in ChatGPT: https://help.openai.com/en/articles/12584461
