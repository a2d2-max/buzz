# Embedded Docs editor

This private package builds a local BlockSuite editor for the a2d2 Docs iframe.
The host application owns identity, relay access, optimistic conflict checks and
publication. This frame receives one document and returns a structured snapshot
plus a Markdown display preview; it never receives a private key or API token.

Use `pnpm --filter @a2d2/docs-editor build`, `typecheck` or `test` from the
workspace. Desktop dev/build scripts build this package first. Output goes to
`desktop/public/docs-editor` and is not committed. The editor is fetched when a
user opens it, rather than included in the host React bundle.

## Data and recovery

`affine: { version: 1, data }` stores a base64 JSON envelope containing the Yjs
workspace root, document subdocuments and inline blobs. Markdown is a preview,
not a lossless interchange format for whiteboards or database blocks. Existing
Markdown pages enter the editor through an explicit conversion action.

Snapshots are capped at 262144 base64 characters; individual blobs are capped at
196608 bytes and still count toward that envelope limit. Larger documents fail
visibly. External attachment storage and large database transport are not yet
implemented.

The frame validates parent identity, origin, protocol and per-mount nonce. It
writes recovery immediately and sends debounced previews separately. Only an
acknowledgment for the same frame session, revision and snapshot may clear its
journal. The host scopes recovery by relay, signer and page ID. Unsupported newer
snapshot versions remain the latest head in the host and disable writing, so an
older Markdown cache cannot overwrite them.

The existing Markdown Notion worker holds structured documents. A structured
Notion adapter is required before converting live synchronized documents. Older
app versions do not necessarily preserve these fields; rollout must coordinate
client versions.

## Build boundary

BlockSuite 0.22.4 and its styling compiler are isolated from the host's React 19
and Vite 8 toolchain. See THIRD_PARTY_NOTICES.md for upstream attribution.
The typecheck compiles our integration against the published BlockSuite `dist`
declarations, substituting them only for resolved BlockSuite source paths. It
does not claim to typecheck upstream implementation source with TypeScript 6.

Recovery journal unit tests and host frame-message tests cover late save
acknowledgments and failed saves. Browser verification must additionally cover
real editing, save/reopen, database/whiteboard content and assets. Packaged Tauri
verification is distinct from a development-server browser test.
