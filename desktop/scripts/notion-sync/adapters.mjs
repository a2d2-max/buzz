import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { verifyEvent } from "nostr-tools";
import { createBuzzCliPublicationApi } from "../notion-import/buzzCliPublicationAdapter.ts";
import {
  buildDocPageEventInput,
  parseDocPageEvent,
} from "../../src/features/docs/lib/docPageCodec.ts";
import {
  compareDocPageVersions,
  nextDocEventCreatedAt,
} from "../../src/features/docs/lib/docTree.ts";

export const DATABASE = "3ad62a7535ba8028935cde50d43e47a4";
export const SOURCE = "3ad62a75-35ba-8088-b9ef-000b2fdc909e";
export const SIGNER =
  "898f424668f581796463b54c862501e71c6cef60563780ac8c03896e02bfe20e";
export const RELAY = "wss://buzz.a2d2lab.com";
const run = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const norm = (text) => text.replaceAll("\r\n", "\n").trimEnd();
export const idKey = (id) => id.replaceAll("-", "");
function propertyText(p) {
  const v = p[p.type];
  if (v == null) return "";
  switch (p.type) {
    case "status":
    case "select":
      return v.name ?? "";
    case "multi_select":
    case "people":
      return v
        .map((x) => x.name ?? "")
        .filter(Boolean)
        .join(", ");
    case "rich_text":
      return v.map((x) => x.plain_text ?? x.text?.content ?? "").join("");
    case "date":
      return [v.start, v.end].filter(Boolean).join(" → ");
    case "checkbox":
      return v ? "완료" : "미완료";
    case "formula":
      return propertyText(v);
    case "rollup":
      return v.type === "array"
        ? v.array.map(propertyText).filter(Boolean).join(", ")
        : propertyText(v);
    case "relation":
      return v.length ? `연결 항목 ${v.length}개 · Notion에서 확인` : "";
    case "files":
      return v.map((x) => x.name).join(", ");
    case "created_by":
    case "last_edited_by":
      return v.name ?? "";
    case "unique_id":
      return [v.prefix, v.number].filter((x) => x != null).join("-");
    default:
      return typeof v === "string" || typeof v === "number" ? String(v) : "";
  }
}
const cell = (text) =>
  String(text)
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|")
    .replaceAll("\n", " ")
    .replaceAll("\r", " ");
export function metadataPrefix(page) {
  const rows = Object.entries(page.properties)
    .filter(([, p]) => p.type !== "title")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, p]) => [name, propertyText(p)])
    .filter(([, v]) => v !== "")
    .map(([name, v]) => `| ${cell(name)} | ${cell(v)} |`);
  const properties = rows.length
    ? `### Notion 속성\n\n속성은 Notion에서 수정하면 반영됩니다.\n\n| 속성 | 값 |\n| --- | --- |\n${rows.join("\n")}\n\n`
    : "";
  return `[Notion 원본](https://app.notion.com/p/${idKey(page.id)})\n\n${properties}## 본문\n`;
}
export function splitBody(text, prefix) {
  const marker = prefix.trimEnd();
  if (!text.startsWith(marker)) throw Error("notion-metadata-edited");
  const rest = text.slice(marker.length);
  if (rest && !rest.startsWith("\n")) throw Error("notion-metadata-edited");
  return rest.replace(/^\n/, "");
}
/** This worker understands Markdown only; structured documents require the new adapter. */
export function assertMarkdownDoc(doc) {
  if (doc?.page?.affine || doc?.page?.unsupportedEditor)
    throw Error("structured-document-needs-affine-sync");
}

export function validateMarkdown(m) {
  if (
    typeof m.markdown !== "string" ||
    m.truncated !== false ||
    !Array.isArray(m.unknown_block_ids) ||
    m.unknown_block_ids.length
  )
    throw Error("notion-markdown-incomplete");
  return norm(m.markdown);
}
export async function connect(cli) {
  const { stdout } = await run(
    "python3",
    [fileURLToPath(new URL("./keychain.py", import.meta.url))],
    { maxBuffer: 8192, timeout: 30000 },
  );
  const token = stdout.trim();
  if (token.length < 30) throw Error("notion-token-missing");
  let next = 0;
  const bodyCache = new Map();
  async function request(path, method = "GET", data) {
    if (method === "PATCH" && path.startsWith("pages/"))
      bodyCache.delete(path.split("/")[1]);
    // All requests remain on the official API; no redirects can forward authentication.
    for (let attempt = 0; attempt < 4; attempt++) {
      await sleep(Math.max(0, next - Date.now()));
      next = Date.now() + 350;
      const r = await fetch(`https://api.notion.com/v1/${path}`, {
        method,
        redirect: "error",
        headers: {
          Authorization: `Bearer ${token}`,
          "Notion-Version": "2026-03-11",
          "Content-Type": "application/json",
        },
        body: data === undefined ? undefined : JSON.stringify(data),
        signal: AbortSignal.timeout(30000),
      });
      if (r.status === 429) {
        await r.body?.cancel();
        await sleep(
          Math.min(
            60000,
            Math.max(1000, Number(r.headers.get("retry-after") || "2") * 1000),
          ),
        );
        continue;
      }
      if (!r.ok) {
        await r.body?.cancel();
        throw Error(`notion-http-${r.status}`);
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of r.body) {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) throw Error("notion-response-too-large");
        chunks.push(chunk);
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    }
    throw Error("notion-rate-limit-retries-exhausted");
  }
  const buzz = createBuzzCliPublicationApi({ buzzCliPath: cli });
  if (
    (await buzz.getCurrentRelay()) !== RELAY ||
    (await buzz.getCurrentSignerPubkey()) !== SIGNER
  )
    throw Error("buzz-identity-mismatch");
  async function doc(id) {
    const events = await buzz.queryDocVersions(id);
    if (events.length >= 100)
      throw Error("docs-version-query-may-be-truncated");
    const pages = [];
    for (const event of events) {
      if (!verifyEvent(event)) throw Error("invalid-doc-signature");
      const p = parseDocPageEvent(event);
      if (p && p.id === id) pages.push(p);
    }
    pages.sort(compareDocPageVersions);
    const p = pages.at(-1);
    return p
      ? {
          title: p.title,
          body: norm(p.body),
          version: p.eventId,
          deleted: p.deleted,
          page: p,
        }
      : null;
  }
  async function publish(id, next, before, parentId = DATABASE) {
    const current = await doc(id);
    if (current?.version !== before?.version) throw Error("docs-stale-base");
    assertMarkdownDoc(current);
    const at = nextDocEventCreatedAt(
      Math.floor(Date.now() / 1000),
      current?.page.eventCreatedAt,
    );
    if (at === null) throw Error("docs-clock-skew");
    const page = {
      id,
      title: next.title,
      body: next.body,
      parentId: current?.page.parentId ?? parentId,
      order: current?.page.order ?? 0,
      createdAt: current?.page.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    };
    const input = buildDocPageEventInput(page);
    if (Buffer.byteLength(input.content) > 256 * 1024)
      throw Error("docs-content-exceeds-safe-limit");
    const event = await buzz.signEvent({ ...input, createdAt: at });
    const result = await buzz.publishEvent(event);
    if (!result.accepted) throw Error("docs-publish-rejected");
    const after = await doc(id);
    if (after?.version !== event.id) throw Error("docs-readback-failed");
    return after;
  }
  async function readNotion(id) {
    const page = await request(`pages/${id}`);
    if (
      page.parent?.data_source_id !== SOURCE ||
      page.archived ||
      page.in_trash
    )
      return { deleted: true };
    const title = Object.values(page.properties).find(
      (p) => p.type === "title",
    );
    if (!title) throw Error("notion-title-missing");
    const cached = bodyCache.get(id);
    let m;
    if (
      cached &&
      cached.version === page.last_edited_time &&
      Date.now() - cached.at < 60000
    ) {
      m = cached.markdown;
    } else {
      m = await request(`pages/${id}/markdown`);
      const again = await request(`pages/${id}`);
      if (page.last_edited_time !== again.last_edited_time)
        throw Error("notion-changed-during-read");
      validateMarkdown(m);
      if (bodyCache.size >= 10000) bodyCache.clear();
      bodyCache.set(id, {
        version: page.last_edited_time,
        markdown: m,
        at: Date.now(),
      });
    }
    const prefix = metadataPrefix(page);
    return {
      title: title.title.map((t) => t.plain_text).join(""),
      body: norm(prefix + validateMarkdown(m)),
      version: page.last_edited_time,
      prefix,
      rawBody: m.markdown,
      titleId: title.id,
    };
  }
  function pageIO(id, save) {
    return {
      readNotion: () => readNotion(id),
      readDoc: async () => {
        const current = await doc(idKey(id));
        assertMarkdownDoc(current);
        return current;
      },
      save,
      async writeDoc(next, before) {
        const now = await readNotion(id);
        if (now.version !== next.version || now.body !== next.body)
          throw Error("notion-stale-source");
        await publish(idKey(id), next, before);
      },
      async writeNotion(next, before) {
        const now = await readNotion(id),
          current = await doc(idKey(id));
        assertMarkdownDoc(current);
        if (
          now.deleted ||
          now.version !== before.version ||
          now.body !== before.body ||
          current?.version !== next.version
        )
          throw Error("notion-stale-base");
        const body = norm(splitBody(next.body, now.prefix));
        const old = norm(now.rawBody);

        if (body !== old) {
          if (
            /<(?:page|database|unknown|meeting-notes|synced_block)\b/i.test(
              `${old}\n${body}`,
            )
          )
            throw Error("notion-complex-block-edit-needs-review");
          if (old) {
            await request(`pages/${id}/markdown`, "PATCH", {
              type: "update_content",
              update_content: {
                content_updates: [{ old_str: now.rawBody, new_str: body }],
              },
            });
          } else {
            await request(`pages/${id}/markdown`, "PATCH", {
              type: "insert_content",
              insert_content: { content: body },
            });
          }
        }
        if (next.title !== now.title) {
          const afterBody = await readNotion(id),
            latestDoc = await doc(idKey(id));
          assertMarkdownDoc(latestDoc);
          if (
            afterBody.deleted ||
            afterBody.title !== now.title ||
            norm(afterBody.rawBody) !== body ||
            latestDoc?.version !== next.version
          )
            throw Error("notion-changed-before-title-write");
          await request(`pages/${id}`, "PATCH", {
            properties: {
              [now.titleId]: { title: [{ text: { content: next.title } }] },
            },
          });
        }
      },
    };
  }
  async function list() {
    const db = await request(`databases/${DATABASE}`);
    if (!db.data_sources?.some((s) => s.id === SOURCE))
      throw Error("notion-data-source-mismatch");
    const pages = [];
    let cursor;
    for (let i = 0; i < 100; i++) {
      const r = await request(`data_sources/${SOURCE}/query`, "POST", {
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {}),
      });
      pages.push(...r.results);
      if (!r.has_more) return { db, pages };
      if (!r.next_cursor || r.next_cursor === cursor)
        throw Error("notion-pagination-stalled");
      cursor = r.next_cursor;
    }
    throw Error("notion-page-limit");
  }
  return { request, doc, publish, readNotion, pageIO, list };
}
