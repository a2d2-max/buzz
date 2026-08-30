import assert from "node:assert/strict";
import { describe, test } from "node:test";

const {
  artifactRepresentationForKind,
  loadOpsArtifactText,
  opsArtifactQueryKey,
} = await import("./artifactReader.ts");

const ARTIFACT = {
  id: "artifact:0123456789abcdef0123456789abcdef",
  title: "Parity report",
  kind: "markdown",
  status: "ready",
  version: 7,
};
const HANDLE = "artifact-handle:01234567-89ab-4def-8123-456789abcdef";

describe("native Ops artifact reader", () => {
  test("maps representations without allowing image artifacts to cross the read boundary", () => {
    assert.equal(artifactRepresentationForKind("html"), "rendered");
    assert.equal(artifactRepresentationForKind("markdown"), "preview");
    assert.equal(artifactRepresentationForKind("json"), "preview");
    assert.equal(artifactRepresentationForKind("text"), "preview");
    assert.equal(artifactRepresentationForKind("report"), "preview");
    assert.equal(artifactRepresentationForKind("image"), null);
    assert.equal(artifactRepresentationForKind("screenshot"), null);
  });

  test("uses the immutable identity tuple as the exact query key", () => {
    assert.deepEqual(opsArtifactQueryKey(ARTIFACT, "preview"), [
      "ops",
      "artifact",
      ARTIFACT.id,
      7,
      "preview",
    ]);
  });

  test("streams opaque handles sequentially in bounded chunks and releases exactly once", async () => {
    const reads = [];
    const releases = [];
    const first = new TextEncoder().encode("first ");
    const second = new TextEncoder().encode("second");
    const bytes = new Uint8Array([...first, ...second]);
    const api = {
      async readArtifact(request) {
        assert.deepEqual(request, {
          artifact_id: ARTIFACT.id,
          version: 7,
          representation: "preview",
        });
        return {
          contract_version: 1,
          artifact_id: ARTIFACT.id,
          version: 7,
          representation: "preview",
          mime: "text/plain",
          total_size: bytes.byteLength,
          sha256: "a".repeat(64),
          kind: "opaque_handle",
          handle: HANDLE,
          expires_at: "2099-01-01T00:00:00.000Z",
        };
      },
      async readHandle(request) {
        reads.push(request);
        const part = request.offset === 0 ? first : second;
        const next = request.offset + part.byteLength;
        return {
          contract_version: 1,
          handle: HANDLE,
          mime: "text/plain",
          offset: request.offset,
          next_offset: next,
          total_size: bytes.byteLength,
          data_base64: Buffer.from(part).toString("base64"),
          eof: next === bytes.byteLength,
        };
      },
      async releaseHandle(handle) {
        releases.push(handle);
        return { released: true };
      },
    };

    const content = await loadOpsArtifactText(ARTIFACT, "preview", {
      api,
    });
    assert.equal(content.text, "first second");
    assert.equal(content.mime, "text/plain");
    assert.equal(content.source, "opaque");
    assert.equal(content.blob.type, "text/plain");
    assert.equal(content.blob.size, bytes.byteLength);
    assert.deepEqual(reads, [
      { handle: HANDLE, offset: 0, length: bytes.byteLength },
      { handle: HANDLE, offset: first.byteLength, length: second.byteLength },
    ]);
    assert.deepEqual(releases, [HANDLE]);
  });

  test("rejects handle metadata drift and still releases the opaque capability", async () => {
    let releases = 0;
    const api = {
      async readArtifact() {
        return {
          contract_version: 1,
          artifact_id: ARTIFACT.id,
          version: 7,
          representation: "preview",
          mime: "text/plain",
          total_size: 3,
          sha256: "b".repeat(64),
          kind: "opaque_handle",
          handle: HANDLE,
          expires_at: "2099-01-01T00:00:00.000Z",
        };
      },
      async readHandle() {
        return {
          contract_version: 1,
          handle: HANDLE,
          mime: "text/html",
          offset: 0,
          next_offset: 3,
          total_size: 3,
          data_base64: "YWJj",
          eof: true,
        };
      },
      async releaseHandle() {
        releases += 1;
        return { released: true };
      },
    };

    await assert.rejects(
      loadOpsArtifactText(ARTIFACT, "preview", { api }),
      /ops_bridge_contract_invalid/u,
    );
    assert.equal(releases, 1);
  });

  test("honors cancellation before another handle chunk and releases", async () => {
    const controller = new AbortController();
    let reads = 0;
    let releases = 0;
    const api = {
      async readArtifact() {
        return {
          contract_version: 1,
          artifact_id: ARTIFACT.id,
          version: 7,
          representation: "preview",
          mime: "text/plain",
          total_size: 2,
          sha256: "c".repeat(64),
          kind: "opaque_handle",
          handle: HANDLE,
          expires_at: "2099-01-01T00:00:00.000Z",
        };
      },
      async readHandle() {
        reads += 1;
        controller.abort();
        return {
          contract_version: 1,
          handle: HANDLE,
          mime: "text/plain",
          offset: 0,
          next_offset: 1,
          total_size: 2,
          data_base64: "YQ==",
          eof: false,
        };
      },
      async releaseHandle() {
        releases += 1;
        return { released: true };
      },
    };

    await assert.rejects(
      loadOpsArtifactText(ARTIFACT, "preview", {
        api,
        signal: controller.signal,
      }),
      (error) => error?.name === "AbortError",
    );
    assert.equal(reads, 1);
    assert.equal(releases, 1);
  });

  test("releases an opaque handle returned after the read was cancelled", async () => {
    const controller = new AbortController();
    let reads = 0;
    let releases = 0;
    const api = {
      async readArtifact() {
        controller.abort();
        return {
          contract_version: 1,
          artifact_id: ARTIFACT.id,
          version: 7,
          representation: "preview",
          mime: "text/plain",
          total_size: 3,
          sha256: "d".repeat(64),
          kind: "opaque_handle",
          handle: HANDLE,
          expires_at: "2099-01-01T00:00:00.000Z",
        };
      },
      async readHandle() {
        reads += 1;
        throw new Error("cancelled reads must not continue");
      },
      async releaseHandle() {
        releases += 1;
        return { released: true };
      },
    };

    await assert.rejects(
      loadOpsArtifactText(ARTIFACT, "preview", {
        api,
        signal: controller.signal,
      }),
      (error) => error?.name === "AbortError",
    );
    assert.equal(reads, 0);
    assert.equal(releases, 1);
  });
});
