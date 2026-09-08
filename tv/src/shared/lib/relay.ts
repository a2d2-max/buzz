// 릴레이 읽기 연결. web/src/shared/lib/nostr-client.ts 를 씨앗으로,
// TV 에 맞게 세 가지를 바꿨다:
//  1) 1회성 REQ→EOSE→닫기 가 아니라 연결 하나를 계속 살려 두고 구독을 얹는다
//     (타임라인 자동 갱신 — 과거분과 실시간이 한 REQ 라 사이 틈이 없다)
//  2) NIP-07 확장 대신 관전용 키(TV 저장)로 NIP-42 에 서명한다
//  3) 끊기면 지수 백오프(상한 30초)로 재접속하고 살아 있는 구독을 다시 건다

import { makeAuthEvent } from "nostr-tools/nip42";
import { finalizeEvent } from "nostr-tools/pure";
import { hexToBytes } from "./settings.ts";

export interface NostrFilter {
  ids?: string[];
  authors?: string[];
  kinds?: number[];
  since?: number;
  until?: number;
  limit?: number;
  [tag: `#${string}`]: string[] | undefined;
}

export type NostrEvent = {
  id: string;
  pubkey: string;
  kind: number;
  content: string;
  created_at: number;
  tags: string[][];
  sig: string;
};

export type RelayStatus =
  | "connecting"
  | "ready"
  | "auth-failed"
  | "reconnecting"
  | "closed";

type SubscriptionHandlers = {
  onEvent: (event: NostrEvent) => void;
  onEose?: () => void;
  onClosed?: (reason: string) => void;
};

type ActiveSubscription = SubscriptionHandlers & {
  id: string;
  filter: NostrFilter;
};

const AUTH_WAIT_MS = 100;
const QUERY_TIMEOUT_MS = 10_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export class RelayConnection {
  private ws: WebSocket | null = null;
  /** 재접속 세대. 늦게 도착한 옛 소켓 이벤트가 새 상태를 덮지 못하게 막는다. */
  private generation = 0;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private subscriptions = new Map<string, ActiveSubscription>();
  private nextSubSeq = 0;
  private authEventId: string | null = null;
  private reqsFlushed = false;
  private unauthenticatedReqTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  status: RelayStatus = "connecting";
  onStatusChange: ((status: RelayStatus) => void) | null = null;

  private readonly url: string;
  private readonly secretKeyHex: string;

  constructor(url: string, secretKeyHex: string) {
    this.url = url;
    this.secretKeyHex = secretKeyHex;
    this.connect();
  }

  dispose(): void {
    this.disposed = true;
    this.subscriptions.clear();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.unauthenticatedReqTimer)
      clearTimeout(this.unauthenticatedReqTimer);
    try {
      this.ws?.close();
    } catch {
      // 무시
    }
    this.setStatus("closed");
  }

  /** 구독을 얹는다. EOSE 뒤에도 열려 있어 실시간 이벤트가 계속 들어온다. */
  subscribe(filter: NostrFilter, handlers: SubscriptionHandlers): () => void {
    const id = `tv-${(this.nextSubSeq++).toString(36)}`;
    const sub: ActiveSubscription = { id, filter, ...handlers };
    this.subscriptions.set(id, sub);
    if (this.reqsFlushed && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(["REQ", id, filter]));
    }
    return () => {
      this.subscriptions.delete(id);
      if (this.ws?.readyState === WebSocket.OPEN) {
        try {
          this.ws.send(JSON.stringify(["CLOSE", id]));
        } catch {
          // 무시
        }
      }
    };
  }

  /** 1회성 조회: EOSE 까지 모아 돌려주고 구독을 닫는다. */
  queryOnce(filter: NostrFilter): Promise<NostrEvent[]> {
    return new Promise((resolve, reject) => {
      const events: NostrEvent[] = [];
      let done = false;
      const timeout = setTimeout(() => {
        if (!done) {
          done = true;
          unsubscribe();
          reject(
            new Error(
              `릴레이 응답이 ${QUERY_TIMEOUT_MS / 1000}초 안에 오지 않았습니다`,
            ),
          );
        }
      }, QUERY_TIMEOUT_MS);
      const unsubscribe = this.subscribe(filter, {
        onEvent: (event) => {
          if (!done) events.push(event);
        },
        onEose: () => {
          if (!done) {
            done = true;
            clearTimeout(timeout);
            unsubscribe();
            resolve(events);
          }
        },
        onClosed: (reason) => {
          if (!done) {
            done = true;
            clearTimeout(timeout);
            unsubscribe();
            reject(new Error(reason));
          }
        },
      });
    });
  }

  private setStatus(status: RelayStatus): void {
    this.status = status;
    this.onStatusChange?.(status);
  }

  private connect(): void {
    if (this.disposed) return;
    this.generation += 1;
    const gen = this.generation;
    this.reqsFlushed = false;
    this.authEventId = null;
    this.setStatus(this.reconnectAttempts > 0 ? "reconnecting" : "connecting");

    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.addEventListener("open", () => {
      if (gen !== this.generation) return;
      this.reconnectAttempts = 0;
      // Buzz 릴레이는 접속 즉시 AUTH 를 보낸다. 잠깐 기다렸다가 안 오면
      // 인증 없이 REQ 를 보낸다(공개 릴레이 호환).
      this.unauthenticatedReqTimer = setTimeout(() => {
        if (gen === this.generation) this.flushSubscriptions();
      }, AUTH_WAIT_MS);
    });

    ws.addEventListener("message", (msg) => {
      if (gen !== this.generation) return;
      this.handleMessage(msg, gen);
    });

    ws.addEventListener("error", () => {
      if (gen !== this.generation) return;
      try {
        ws.close();
      } catch {
        // 무시
      }
    });

    ws.addEventListener("close", () => {
      if (gen !== this.generation) return;
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.disposed) return;
    if (this.unauthenticatedReqTimer) {
      clearTimeout(this.unauthenticatedReqTimer);
      this.unauthenticatedReqTimer = null;
    }
    // 인증 실패는 키 문제라 재시도해도 같은 결과다 — 멈추고 화면에 맡긴다.
    if (this.status === "auth-failed") return;
    this.setStatus("reconnecting");
    const delay = Math.min(
      RECONNECT_BASE_MS * 2 ** this.reconnectAttempts,
      RECONNECT_MAX_MS,
    );
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private flushSubscriptions(): void {
    if (this.unauthenticatedReqTimer) {
      clearTimeout(this.unauthenticatedReqTimer);
      this.unauthenticatedReqTimer = null;
    }
    if (this.reqsFlushed) return;
    this.reqsFlushed = true;
    this.setStatus("ready");
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    for (const sub of this.subscriptions.values()) {
      this.ws.send(JSON.stringify(["REQ", sub.id, sub.filter]));
    }
  }

  private handleMessage(msg: MessageEvent, gen: number): void {
    let data: unknown;
    try {
      data = JSON.parse(String(msg.data));
    } catch {
      return;
    }
    if (!Array.isArray(data)) return;
    const [type] = data;

    if (type === "AUTH" && typeof data[1] === "string") {
      if (this.unauthenticatedReqTimer) {
        clearTimeout(this.unauthenticatedReqTimer);
        this.unauthenticatedReqTimer = null;
      }
      try {
        const template = makeAuthEvent(this.url, data[1]);
        const signed = finalizeEvent(
          { ...template, created_at: Math.floor(Date.now() / 1000) },
          hexToBytes(this.secretKeyHex),
        );
        if (gen !== this.generation) return;
        this.authEventId = signed.id;
        this.ws?.send(JSON.stringify(["AUTH", signed]));
      } catch {
        this.setStatus("auth-failed");
      }
      return;
    }

    if (type === "OK" && data[1] === this.authEventId) {
      if (data[2] === true) {
        this.flushSubscriptions();
      } else {
        this.setStatus("auth-failed");
        try {
          this.ws?.close();
        } catch {
          // 무시
        }
      }
      return;
    }

    if (type === "EVENT" && typeof data[1] === "string" && data[2]) {
      this.subscriptions.get(data[1])?.onEvent(data[2] as NostrEvent);
    } else if (type === "EOSE" && typeof data[1] === "string") {
      this.subscriptions.get(data[1])?.onEose?.();
    } else if (type === "CLOSED" && typeof data[1] === "string") {
      const sub = this.subscriptions.get(data[1]);
      if (sub) {
        this.subscriptions.delete(data[1]);
        sub.onClosed?.(
          typeof data[2] === "string" ? data[2] : "릴레이가 구독을 닫았습니다",
        );
      }
    }
  }
}
