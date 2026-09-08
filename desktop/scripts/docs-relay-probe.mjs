/**
 * Runtime probe for the Docs relay assumptions, against a REAL buzz-relay.
 *
 * Runs the production scan (`fetchDocPagesToExhaustion`) and codec over a
 * plain WebSocket NIP-01/NIP-42 client, so what is measured is the relay's
 * actual REQ behaviour, not the fake relay from the unit tests:
 *   1. `#t`-filtered REQ starves once >1000 newer kind-30078 rows exist.
 *   2. The kinds-only paged scan still finds every page.
 *   3. `#d` lookup returns every author's version of one page.
 *   4. An incremental (`since`) scan finds pages in one request.
 *   5. A live `#t` subscription delivers a page published by someone else.
 *
 * Usage (from desktop/): RELAY_URL=ws://localhost:3100 node --import ./test-loader.mjs \
 *   --experimental-strip-types <this file>
 */
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure";

import {
  buildDocPageEventInput,
  docPageDTag,
  parseDocPageEvent,
} from "@/features/docs/lib/docPageCodec";
import { fetchDocPagesToExhaustion } from "@/features/docs/lib/docsHistory";
import { pickLatestDocPages } from "@/features/docs/lib/docTree";

const RELAY_URL = process.env.RELAY_URL ?? "ws://localhost:3100";
const NOISE_TOTAL = Number(process.env.NOISE_TOTAL ?? 1_100);
const NOISE_IDENTITIES = Number(process.env.NOISE_IDENTITIES ?? 25);
const now = () => Math.floor(Date.now() / 1_000);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class Conn {
  constructor(secretKey) {
    this.sk = secretKey;
    this.pk = getPublicKey(secretKey);
    this.pending = new Map();
    this.subs = new Map();
    this.live = new Map();
    this.authed = deferred();
    this.notices = [];
  }
  async open() {
    this.ws = new WebSocket(RELAY_URL);
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = () => reject(new Error("websocket error"));
    });
    this.ws.onmessage = (message) => this.handle(JSON.parse(message.data));
    await Promise.race([
      this.authed.promise,
      sleep(5_000).then(() => {
        throw new Error("AUTH did not complete within 5 s");
      }),
    ]);
  }
  handle(msg) {
    const [type, ...rest] = msg;
    if (type === "AUTH") {
      const event = finalizeEvent(
        {
          kind: 22242,
          created_at: now(),
          tags: [
            ["relay", RELAY_URL],
            ["challenge", rest[0]],
          ],
          content: "",
        },
        this.sk,
      );
      this.authId = event.id;
      this.send(["AUTH", event]);
      return;
    }
    if (type === "OK") {
      const [id, ok, message] = rest;
      if (id === this.authId) {
        ok ? this.authed.resolve() : this.authed.reject(new Error(message));
        return;
      }
      const waiter = this.pending.get(id);
      if (waiter) {
        this.pending.delete(id);
        ok ? waiter.resolve() : waiter.reject(new Error(message ?? "rejected"));
      }
      return;
    }
    if (type === "EVENT") {
      const [subId, event] = rest;
      this.subs.get(subId)?.events.push(event);
      this.live.get(subId)?.(event);
      return;
    }
    if (type === "EOSE") {
      const sub = this.subs.get(rest[0]);
      if (sub) {
        this.subs.delete(rest[0]);
        if (!this.live.has(rest[0])) this.send(["CLOSE", rest[0]]);
        sub.resolve(sub.events);
      }
      return;
    }
    if (type === "CLOSED") {
      const sub = this.subs.get(rest[0]);
      if (sub) {
        this.subs.delete(rest[0]);
        sub.reject(new Error(`CLOSED: ${rest[1]}`));
      }
      return;
    }
    if (type === "NOTICE") this.notices.push(rest[0]);
  }
  send(msg) {
    this.ws.send(JSON.stringify(msg));
  }
  async publish(template, { retries = 20 } = {}) {
    for (let attempt = 0; ; attempt += 1) {
      const event = finalizeEvent(template, this.sk);
      try {
        await new Promise((resolve, reject) => {
          this.pending.set(event.id, { resolve, reject });
          this.send(["EVENT", event]);
        });
        return event;
      } catch (error) {
        if (attempt >= retries || !/rate/i.test(String(error.message)))
          throw error;
        await sleep(1_000 + attempt * 250);
      }
    }
  }
  req(filter, { onLive } = {}) {
    const subId = `s${Math.random().toString(36).slice(2, 10)}`;
    return new Promise((resolve, reject) => {
      this.subs.set(subId, { events: [], resolve, reject });
      if (onLive) this.live.set(subId, onLive);
      this.send(["REQ", subId, filter]);
    });
  }
  close() {
    this.ws.close();
  }
}

function docTemplate({
  id,
  title,
  body,
  createdAt,
  parentId = null,
  order = 0,
}) {
  const input = buildDocPageEventInput({
    id,
    title,
    body,
    parentId,
    order,
    createdAt: createdAt * 1_000,
    updatedAt: createdAt * 1_000,
  });
  return {
    kind: input.kind,
    tags: input.tags,
    content: input.content,
    created_at: createdAt,
  };
}

const report = [];
const check = (label, ok, detail) => {
  report.push({ label, ok, detail });
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`,
  );
};

const authorA = new Conn(generateSecretKey());
const authorB = new Conn(generateSecretKey());
await authorA.open();
await authorB.open();
console.log(
  `authenticated A=${authorA.pk.slice(0, 8)} B=${authorB.pk.slice(0, 8)} at ${RELAY_URL}`,
);

// 1. Three pages, stamped older than the noise that will follow.
const base = now() - 300;
const pageIds = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
for (const [index, id] of pageIds.entries()) {
  await authorA.publish(
    docTemplate({
      id,
      title: `Doc ${index + 1}`,
      body: `# Doc ${index + 1}\n\nbody`,
      createdAt: base + index,
      order: index,
    }),
  );
}
console.log("published 3 pages");

// 2. Noise: kind 30078 rows with another `t`, newer than the pages, spread
//    across identities so the per-user write budget is not the bottleneck.
const noiseConns = [];
for (let index = 0; index < NOISE_IDENTITIES; index += 1) {
  const conn = new Conn(generateSecretKey());
  await conn.open();
  noiseConns.push(conn);
}
const perIdentity = Math.ceil(NOISE_TOTAL / NOISE_IDENTITIES);
const noiseStart = Date.now();
let noisePublished = 0;
await Promise.all(
  noiseConns.map(async (conn, identityIndex) => {
    for (
      let n = 0;
      n < perIdentity && identityIndex * perIdentity + n < NOISE_TOTAL;
      n += 1
    ) {
      const serial = identityIndex * perIdentity + n;
      await conn.publish({
        kind: 30078,
        created_at: now(),
        tags: [
          ["d", `lab-noise:${String(serial).padStart(6, "0")}`],
          ["t", "lab-noise"],
        ],
        content: "x",
      });
      noisePublished += 1;
    }
  }),
);
console.log(
  `published ${noisePublished} noise rows in ${((Date.now() - noiseStart) / 1_000).toFixed(1)} s`,
);
for (const conn of noiseConns) conn.close();

// 3. Starvation: the `#t`-filtered REQ the first implementation used.
const starved = await authorA.req({
  kinds: [30078],
  "#t": ["community-doc"],
  limit: 1_000,
});
const starvedDocs = starved.map(parseDocPageEvent).filter(Boolean);
check(
  "#t-filtered REQ starves behind >1000 newer rows (the bug)",
  starvedDocs.length < pageIds.length,
  `returned ${starvedDocs.length}/${pageIds.length} pages`,
);
const window1000 = await authorA.req({ kinds: [30078], limit: 1_000 });
check(
  "kinds-only REQ returns exactly the 1000-row window",
  window1000.length === 1_000,
  `${window1000.length} rows`,
);

// 4. The fix: kinds-only paged scan through the production code.
let requests = 0;
const countingFetch = (filter) => {
  requests += 1;
  return authorA.req(filter);
};
const scan = await fetchDocPagesToExhaustion({ fetchEvents: countingFetch });
const found = pickLatestDocPages(scan.pages);
check(
  "paged kinds-only scan finds every page",
  pageIds.every((id) => found.has(id)) && !scan.truncated,
  `${found.size} pages, ${requests} REQs, scanned ${scan.scanned} rows, truncated=${scan.truncated}, newestSeen=${scan.newestSeen}`,
);

// 5. `#d` lookup across authors after B republishes page 1.
const bVersion = await authorB.publish(
  docTemplate({
    id: pageIds[0],
    title: "Doc 1 (B)",
    body: "# Doc 1\n\ntheirs",
    createdAt: now() + 5,
  }),
);
const versions = await authorA.req({
  kinds: [30078],
  "#d": [docPageDTag(pageIds[0])],
  limit: 200,
});
const parsedVersions = versions.map(parseDocPageEvent).filter(Boolean);
const newest = pickLatestDocPages(parsedVersions).get(pageIds[0]);
check(
  "#d lookup returns every author's version and resolves the newest",
  parsedVersions.length === 2 && newest?.eventId === bVersion.id,
  `${parsedVersions.length} versions, newest by ${newest?.author.slice(0, 8)}`,
);

// 6. Incremental scan anchored on relay-stamped time.
let incrementalRequests = 0;
const incremental = await fetchDocPagesToExhaustion({
  fetchEvents: (filter) => {
    incrementalRequests += 1;
    return authorA.req(filter);
  },
  since: scan.newestSeen - (2 * 900 + 60),
});
const incrementalFound = pickLatestDocPages(incremental.pages);
check(
  "incremental scan (since = newestSeen − 1860) sees the pages and B's version",
  pageIds.every((id) => incrementalFound.has(id)) &&
    incrementalFound.get(pageIds[0])?.eventId === bVersion.id,
  `${incrementalRequests} REQs, scanned ${incremental.scanned}`,
);

// 7. Live subscription with `#t` delivers another author's page.
const liveArrival = deferred();
const livePageId = crypto.randomUUID();
await authorA.req(
  { kinds: [30078], "#t": ["community-doc"], limit: 0 },
  {
    onLive: (event) => {
      const page = parseDocPageEvent(event);
      if (page?.id === livePageId) liveArrival.resolve(page);
    },
  },
);
await authorB.publish(
  docTemplate({
    id: livePageId,
    title: "Live page",
    body: "live",
    createdAt: now(),
  }),
);
const livePage = await Promise.race([
  liveArrival.promise,
  sleep(5_000).then(() => null),
]);
check(
  "live #t subscription delivers another author's new page",
  livePage !== null,
  livePage ? `arrived as ${livePage.title}` : "nothing within 5 s",
);

authorA.close();
authorB.close();
const failures = report.filter((entry) => !entry.ok).length;
console.log(`\n${report.length - failures}/${report.length} checks passed`);
if (authorA.notices.length)
  console.log("relay notices:", authorA.notices.slice(0, 5));
process.exit(failures === 0 ? 0 : 1);
