// 검증용 모의 릴레이 (ws://localhost:7447).
// 실제 Buzz 릴레이처럼 접속 즉시 NIP-42 AUTH 를 요구하고, 인증 뒤 REQ 에
// 미리 넣어 둔 이벤트(채널 39000 · 메시지 9/40002 · 프로필 0 · Docs 30623/30078)를
// 내려 준다. EOSE 5초 뒤 새 메시지 하나를 밀어 자동 갱신도 확인할 수 있다.
// 서명 검증은 하지 않는다 — TV 앱의 읽기 경로를 밟아 보기 위한 발판일 뿐이다.

import { WebSocketServer } from "ws";

const PORT = Number(process.env.MOCK_RELAY_PORT ?? 7447);

const CHANNEL_GENERAL = "11111111-1111-1111-1111-111111111111";
const CHANNEL_RANDOM = "22222222-2222-2222-2222-222222222222";
const ALICE = "a1".repeat(32);
const BOB = "b2".repeat(32);
const now = Math.floor(Date.now() / 1000);

let eventSeq = 0;
function makeEvent(kind, content, tags, pubkey = ALICE, createdAt = now) {
  eventSeq += 1;
  return {
    id: eventSeq.toString(16).padStart(64, "0"),
    pubkey,
    kind,
    created_at: createdAt,
    tags,
    content,
    sig: "0".repeat(128),
  };
}

const EVENTS = [
  // 채널 메타데이터 (relay 가 39000 에 싣는 태그 모양 그대로)
  makeEvent(39000, "", [
    ["d", CHANNEL_GENERAL],
    ["name", "general"],
    ["about", "다 같이 쓰는 방"],
    ["public"],
    ["closed"],
    ["t", "stream"],
  ]),
  makeEvent(39000, "", [
    ["d", CHANNEL_RANDOM],
    ["name", "random"],
    ["about", "아무 얘기"],
    ["public"],
    ["closed"],
    ["t", "stream"],
  ]),
  // 프로필
  makeEvent(
    0,
    JSON.stringify({ name: "앨리스", display_name: "앨리스" }),
    [],
    ALICE,
  ),
  makeEvent(0, JSON.stringify({ name: "밥" }), [], BOB),
  // general 채널 메시지 (kind 9 + 40002 섞어서)
  makeEvent(
    9,
    "첫 메시지입니다. **굵게** 도 됩니다.",
    [["h", CHANNEL_GENERAL]],
    ALICE,
    now - 3600,
  ),
  makeEvent(
    40002,
    "코드 블록도 보입니다:\n\n```ts\nconst answer = 42;\n```",
    [["h", CHANNEL_GENERAL]],
    BOB,
    now - 1800,
  ),
  makeEvent(
    9,
    "- 목록 하나\n- 목록 둘\n\n> 인용도 됩니다",
    [["h", CHANNEL_GENERAL]],
    ALICE,
    now - 600,
  ),
  makeEvent(9, "random 채널의 메시지", [["h", CHANNEL_RANDOM]], BOB, now - 300),
  // Docs: 전용 kind 30623 두 장(부모/자식) + 레거시 30078 한 장
  makeEvent(
    30623,
    JSON.stringify({
      title: "시작하기",
      body: "# 시작하기\n\nTV 에서 읽는 첫 문서입니다.\n\n## 절차\n\n1. 하나\n2. 둘\n\n| 칸 | 값 |\n|---|---|\n| a | 1 |",
      parentId: null,
      order: 1,
      createdAt: 1,
      updatedAt: 2,
    }),
    [
      ["d", "doc:aaaaaaaa-0000-0000-0000-000000000001"],
      ["t", "community-doc"],
    ],
  ),
  makeEvent(
    30623,
    JSON.stringify({
      title: "설치 안내",
      body: "## 설치 안내\n\n부모 문서 아래에 달린 자식 문서.",
      parentId: "aaaaaaaa-0000-0000-0000-000000000001",
      order: 1,
      createdAt: 1,
      updatedAt: 2,
    }),
    [
      ["d", "doc:aaaaaaaa-0000-0000-0000-000000000002"],
      ["t", "community-doc"],
    ],
  ),
  makeEvent(
    30078,
    JSON.stringify({
      title: "옛 창의 문서",
      body: "레거시 kind 30078 에 남아 있는 문서도 읽혀야 한다.",
      parentId: null,
      order: 9,
      createdAt: 1,
      updatedAt: 2,
    }),
    [
      ["d", "doc:bbbbbbbb-0000-0000-0000-000000000003"],
      ["t", "community-doc"],
    ],
  ),
];

function matches(filter, event) {
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false;
  for (const [key, values] of Object.entries(filter)) {
    if (!key.startsWith("#")) continue;
    const tagName = key.slice(1);
    const tagValues = event.tags
      .filter((tag) => tag[0] === tagName)
      .map((tag) => tag[1]);
    if (!values.some((value) => tagValues.includes(value))) return false;
  }
  return true;
}

const server = new WebSocketServer({ port: PORT });
console.log(`모의 릴레이: ws://localhost:${PORT}`);

server.on("connection", (socket) => {
  let authed = false;
  const subs = new Map();
  socket.send(JSON.stringify(["AUTH", `mock-challenge-${Date.now()}`]));

  socket.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(String(raw));
    } catch {
      return;
    }
    const [type] = data;

    if (type === "AUTH" && data[1]?.id) {
      authed = true;
      socket.send(JSON.stringify(["OK", data[1].id, true, ""]));
      return;
    }

    if (type === "REQ") {
      const [, subId, filter] = data;
      if (!authed) {
        socket.send(
          JSON.stringify(["CLOSED", subId, "auth-required: 먼저 인증하세요"]),
        );
        return;
      }
      subs.set(subId, filter);
      for (const event of EVENTS) {
        if (matches(filter, event)) {
          socket.send(JSON.stringify(["EVENT", subId, event]));
        }
      }
      socket.send(JSON.stringify(["EOSE", subId]));
      return;
    }

    if (type === "CLOSE") {
      subs.delete(data[1]);
    }
  });

  // 자동 갱신 확인용: 5초 뒤 general 채널에 새 메시지를 민다.
  const liveTimer = setTimeout(() => {
    const live = makeEvent(
      9,
      "*(실시간)* 방금 도착한 메시지",
      [["h", CHANNEL_GENERAL]],
      BOB,
      Math.floor(Date.now() / 1000),
    );
    EVENTS.push(live);
    for (const [subId, filter] of subs) {
      if (matches(filter, live)) {
        socket.send(JSON.stringify(["EVENT", subId, live]));
      }
    }
  }, 5000);

  socket.on("close", () => clearTimeout(liveTimer));
});
