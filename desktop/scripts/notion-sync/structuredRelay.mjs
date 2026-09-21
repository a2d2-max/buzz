import { createHash } from "node:crypto";
import { finalizeEvent, getPublicKey, nip19, verifyEvent } from "nostr-tools";
/** Persistent authenticated connection; credentials remain process-local and are never returned. */
export async function structuredRelay(relay, expectedSigner) {
  const encoded = process.env.BUZZ_PRIVATE_KEY;
  const key = encoded?.startsWith("nsec1")
    ? nip19.decode(encoded).data
    : Uint8Array.from(Buffer.from(encoded ?? "", "hex"));
  if (key.length !== 32 || getPublicKey(key) !== expectedSigner)
    throw Error("structured-relay-identity-mismatch");
  let auth = process.env.BUZZ_AUTH_TAG;
  if (auth) {
    try {
      auth = JSON.parse(auth);
    } catch {
      auth = auth.slice(1, -1).split(",");
    }
    if (auth[0] !== "auth") throw Error("structured-auth-invalid");
  }
  const sign = (input) =>
    finalizeEvent(
      { ...input, tags: [...input.tags, ...(auth ? [auth] : [])] },
      key,
    );
  const ws = new WebSocket(relay),
    pending = new Map();
  let authId;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.close();
      reject(Error("structured-relay-auth-timeout"));
    }, 15000);
    ws.onerror = () => {
      clearTimeout(timeout);
      reject(Error("structured-relay-connection-failed"));
    };
    ws.onmessage = (event) => {
      const m = JSON.parse(event.data);
      if (m[0] === "AUTH") {
        const event = sign({
          kind: 22242,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ["relay", relay],
            ["challenge", m[1]],
          ],
          content: "",
        });
        authId = event.id;
        ws.send(JSON.stringify(["AUTH", event]));
      } else if (m[0] === "OK" && m[1] === authId) {
        clearTimeout(timeout);
        m[2] ? resolve() : reject(Error("structured-relay-auth-rejected"));
      } else pending.get(m[1])?.(m);
    };
  });
  async function exchange(kind, value) {
    const id = kind === "EVENT" ? value.id : crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const events = [];
      const finish = (error, result) => {
        clearTimeout(timer);
        pending.delete(id);
        if (kind === "REQ" && ws.readyState === 1)
          ws.send(JSON.stringify(["CLOSE", id]));
        error ? reject(error) : resolve(result);
      };
      const timer = setTimeout(
        () => finish(Error("structured-relay-timeout")),
        15000,
      );
      pending.set(id, (m) => {
        if (kind === "EVENT" && m[0] === "OK")
          finish(m[2] ? null : Error(m[3]), m);
        if (kind === "REQ") {
          if (m[0] === "EVENT") {
            if (!verifyEvent(m[2]))
              return finish(Error("invalid-relay-signature"));
            events.push(m[2]);
            if (events.length >= 1000)
              finish(Error("structured-query-truncated"));
          }
          if (m[0] === "EOSE") finish(null, events);
          if (m[0] === "CLOSED") finish(Error("structured-query-closed"));
        }
      });
      ws.send(
        JSON.stringify(kind === "EVENT" ? [kind, value] : [kind, id, value]),
      );
    });
  }
  const base = new URL(relay.replace(/^ws/, "http")).origin;
  async function media(url, method, bytes) {
    if (new URL(url).origin !== base)
      throw Error("structured-media-foreign-origin");
    const now = Math.floor(Date.now() / 1000),
      tags = [
        ["t", method === "PUT" ? "upload" : "get"],
        ["expiration", String(now + 300)],
        ["server", new URL(base).host],
      ];
    if (bytes)
      tags.push(["x", createHash("sha256").update(bytes).digest("hex")]);
    const event = sign({
      kind: 24242,
      created_at: now,
      content: method === "PUT" ? "Upload buzz-media" : "Get buzz-media",
      tags,
    });
    const response = await fetch(url, {
      method,
      redirect: "error",
      headers: {
        ...(auth ? { "x-auth-tag": JSON.stringify(auth) } : {}),
        Authorization: `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64url")}`,
        ...(bytes
          ? {
              "Content-Type": "application/octet-stream",
              "X-SHA-256": createHash("sha256").update(bytes).digest("hex"),
            }
          : {}),
      },
      body: bytes,
      signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw Error(`structured-media-http-${response.status}`);
    }
    return response;
  }
  return {
    async upload(file) {
      const response = await media(
        base + "/upload",
        "PUT",
        new Uint8Array(await file.arrayBuffer()),
      );
      return response.json();
    },
    async fetch(url) {
      const response = await media(url, "GET");
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 32 * 1024 * 1024) {
          await response.body.cancel().catch(() => {});
          throw Error("structured-media-too-large");
        }
        chunks.push(chunk);
      }
      return new Uint8Array(Buffer.concat(chunks));
    },
    query: (filter) => exchange("REQ", filter),
    async publish(input) {
      const event = sign(input);
      await exchange("EVENT", event);
      return event;
    },
    close: () => ws.close(),
  };
}
