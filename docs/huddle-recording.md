# 허들 녹음 형식 `buzz-huddle-recording/1`

허들 회의록 기능의 1단계(릴레이 녹음기)와 2단계(회의록 작업기)가 같이 쓰는 약속이다.
녹음기는 이 형식으로 쓰고, 작업기는 이 형식만 믿고 읽는다. 형식을 바꾸면 `format` 값을 올린다.

진행 기록과 결정 사항은 노션 작업 페이지 "허들 (한국어 및 tiro 기능 구현)"에 있다.

## 무엇을 녹음하나

- **방 주인 쪽에서 모든 사람의 프레임**을 녹음한다. 들어오는 길이 둘이다.
  - 같은 파드에 붙은 사람: `crates/buzz-relay/src/audio/room.rs`의 `Room::broadcast_frame`.
  - 메시에서 다른 파드에 붙은 사람: `crates/buzz-relay/src/audio/mesh.rs`의 `on_media_datagram` →
    `Room::deliver_prefixed`. 이 함수는 주인 파드와 거울 파드 양쪽에서 불리므로,
    **이 파드가 그 허들의 주인일 때만** 녹음한다.
  - 거울 파드(주인이 아닌 파드)는 아무것도 녹음하지 않는다. 그래야 같은 소리가 두 번 녹음되지 않는다.
- 프레임은 **릴레이가 받은 그대로** 저장한다. 릴레이는 Opus를 풀지 않는다.
  프로토콜 v2 이상이면 8바이트 헤더(seq, ts_48k, level, flags) + Opus, v1이면 Opus만 있다.
  (v3은 릴레이가 붙이는 앞머리에 epoch가 더해질 뿐, 클라이언트 프레임 자체는 v2와 같다.)
- 들어오고 나간 기록(명단 변경)도 같이 저장한다. 사람 구분은 `peer_index` + `epoch` → pubkey로 한다.

## 켜고 끄기 (환경 변수)

| 이름 | 기본값 | 뜻 |
|---|---|---|
| `BUZZ_HUDDLE_RECORDING` | `off` | `off`, `local`, `s3` 중 하나. `off`면 녹음기를 아예 만들지 않는다(원본 동작 그대로) |
| `BUZZ_HUDDLE_RECORDING_DIR` | 없음 | `local`일 때 쓸 폴더 |
| `BUZZ_HUDDLE_RECORDING_BUCKET` | 없음 | `s3`일 때 버킷. 운영은 `a2d2-huddle-recordings`(GCS, 15일 삭제 규칙) |
| `BUZZ_HUDDLE_RECORDING_ENDPOINT` | 없음 | S3 호환 주소. GCS는 `https://storage.googleapis.com` |
| `BUZZ_HUDDLE_RECORDING_REGION` | `auto` | S3 서명에 쓰는 지역 이름 |
| `BUZZ_HUDDLE_RECORDING_ACCESS_KEY` / `_SECRET_KEY` | 없음 | S3 호환 키(GCS HMAC). 값은 비밀 저장소에서만 넣는다 |
| `BUZZ_HUDDLE_RECORDING_PREFIX` | `huddles` | 버킷 안 경로 앞부분. 앞뒤 공백만 떼고 `/`로 나눠서, 빈 조각(앞뒤 `/`·`//` 포함)·`.`·`..`·`\`가 들어간 조각이 있으면 기동을 거절한다 |
| `BUZZ_HUDDLE_RECORDING_CHUNK_SECS` | `30` | 조각 하나의 최대 길이(초) |

- 설정이 잘못되면(모르는 모드, 빠진 값, 잘못된 경로) 릴레이가 **시작할 때 실패한다.** 녹음이 조용히 사라지지 않게 하려는 것이다.
- **GCS는 HMAC 키가 꼭 필요하다.** 키를 비우면 AWS 기본 자격 증명 체인을 타서 GKE Workload Identity로는 붙지 않는다.
- GCS 서비스 계정 권한은 버킷 단위로 `roles/storage.objectUser` 수준을 준다. 올리기 재시도 때 같은 이름을 덮어쓸 수 있는데,
  `objectCreator`만 있으면 덮어쓰기에 필요한 삭제 권한이 없어 실제로 올라간 조각이 `lost_chunks`로 세질 수 있다.
- `local` 모드는 개발용이다. 폴더는 0700, 파일은 0600으로 만든다.

## 저장 경로

```
{prefix}/{community_id}/{channel_id}/{session_id}/chunk-{seq:06}.bhr
{prefix}/{community_id}/{channel_id}/{session_id}/manifest.json
```

- `channel_id`는 보통 허들 백킹 채널(ephemeral channel) UUID다. 다만 릴레이는 일반 채널 UUID로 열린 음성 방도 녹음한다
  (허들 음성 경로가 일반 채널 접속을 막지 않기 때문). 이때는 `parent_channel_id`가 `null`이다.
- `session_id`는 **방에 사람이 있는 동안**의 녹음 하나다. 방이 비면 끝나고, 같은 방에 다시 사람이 들어오면 새 세션이다.
  방 객체(`Room`) 수명을 기준으로 삼지 않는다. 채널 보관이 "이미 보관됨"으로 실패하면 빈 방 객체가 지워지지 않고 남는데,
  그 방에 다시 들어온 사람의 세션이 영영 안 끝나기 때문이다. 6시간을 넘겨도 새 세션으로 나뉜다.
- **`manifest.json`은 맨 마지막에 쓴다.** 이게 있으면 녹음이 끝난 것이다.

## 조각 파일 `.bhr`

모든 정수는 big-endian.

머리(36바이트):

| 바이트 | 이름 | 값 |
|---|---|---|
| 4 | magic | `BHR1` |
| 1 | format_version | `1` |
| 1 | protocol_version | 방에 고정된 허들 프로토콜 버전. 모르면 `0` |
| 2 | reserved | `0` |
| 16 | session_id | UUID 바이트 |
| 4 | chunk_seq | 0부터 |
| 8 | session_start_unix_ms | 세션 시작 벽시계(UTC 밀리초) |

그 뒤로 레코드가 파일 끝까지 이어진다.

| 레코드 | 내용 |
|---|---|
| 공통 | `type u8`, `t_ms u32` (세션 시작부터 지난 밀리초. 릴레이의 단조 시계로 잰 **받은 시각**. 한 세션 안에서 레코드 순서대로 **줄지 않는다**) |
| `type=1` 프레임 | `peer_index u8`, `epoch u8`, `len u16`, `payload[len]` (받은 프레임 그대로) |
| `type=2` 들어옴 | `peer_index u8`, `epoch u8`, `pubkey[32]` (x-only pubkey 원래 바이트) |
| `type=3` 나감 | `peer_index u8`, `epoch u8`, `pubkey[32]` |

- 조각 하나의 첫 레코드 앞에는 그 시점의 명단 전체를 `type=2`로 다시 적는다. 그래서 조각 하나만 읽어도 사람을 가릴 수 있다.
  이 다시 적은 `type=2`의 `t_ms`는 **조각을 연 시각**이다. 조각만 봐서는 진짜 들어온 것인지 다시 적은 것인지 못 가리므로,
  진짜 들어온 시각은 `manifest.json`의 `participants`를 본다.
- 프레임은 클라이언트가 보낸 프레임만 저장한다. 릴레이가 붙이는 `[peer_index]`(v3은 `[peer_index][epoch]`) 앞머리는 저장하지 않는다.
- 시각은 소리 헤더의 `ts_48k`가 아니라 `t_ms`로 맞춘다. 음소거·PTT로 쉬는 동안 `ts_48k`는 멈추기 때문이다.
  `ts_48k`와 `seq`는 한 사람 안에서 순서·손실을 볼 때만 쓴다.

## 목록 파일 `manifest.json`

```json
{
  "format": "buzz-huddle-recording/1",
  "community_id": "…",
  "channel_id": "…",
  "parent_channel_id": "… 또는 null",
  "session_id": "…",
  "started_at": "2026-10-12T05:00:00.000Z",
  "ended_at": "2026-10-12T05:42:10.120Z",
  "duration_ms": 2530120,
  "protocol_version": 2,
  "end_reason": "room_empty",
  "chunks": [
    { "seq": 0, "key": "…/chunk-000000.bhr", "bytes": 123456, "records": 4321, "first_t_ms": 0, "last_t_ms": 29980 }
  ],
  "participants": [
    { "pubkey": "hex", "peer_index": 0, "epoch": 1, "joined_t_ms": 0, "left_t_ms": 2530000 }
  ],
  "dropped_frames": 0,
  "lost_chunks": 0
}
```

- `end_reason`: `room_empty`(마지막 사람이 나감), `shutdown`(릴레이가 내려감), `max_duration`(한 세션이 6시간을 넘어 끊고 새 세션으로 넘김).
- `parent_channel_id`: 릴레이가 입장 때 48100으로 확인한 부모 채널. 이럴 땐 `null`이다:
  허들용이 아닌 일반 채널(부모가 채널 자기 자신), 메시에서 다른 파드로 들어온 사람만 있는 세션(주인 쪽 등록에 부모 id가 안 실려 옴).
  `null`이면 작업기가 부모를 직접 찾는다: 부모 채널에는 `content.ephemeral_channel_id`가 이 `channel_id`인 48100 이벤트가 있다.
- `participants`: 같은 사람이 여러 번 들어오면 줄이 여러 개다. `shutdown`·`max_duration`으로 끝날 때 아직 방에 있던 사람의 `left_t_ms`는 세션 끝 시각이다.
  `max_duration` 다음 세션으로 이어받은 사람은 `joined_t_ms`가 `0`이다. 진짜 들어온 시각은 앞 세션의 기록을 본다.
- `chunks`: 올리기에 **성공한** 조각만 들어간다. 실패한 조각은 `lost_chunks`로만 센다.
- `ended_at`은 `started_at + duration_ms`로 계산한 값이다.

## 녹음기가 지킬 것

- **음성 전달을 절대 막지 않는다.** 방마다 녹음 태스크 하나가 큐를 비운다. 큐는 순서를 지키는 줄 하나에
  프레임 개수 카운터(최대 2048개)를 붙인 것이다. 프레임이 2048개를 넘으면 버리고 `dropped_frames`를 센다.
  명단 이벤트(들어옴·나감)는 버리지 않는다. 들어옴 기록이 그 사람의 첫 프레임보다 먼저 와야 해서 줄을 하나로 둔다.
- 조각은 `CHUNK_SECS`가 지나거나 4MiB가 되면 올린다. 올리기는 4번까지 시도한다(쉬는 시간 0.25·1·4초, 한 번에 30초 제한). 그래도 안 되면 `lost_chunks`를 센다.
- 끝내는 기준은 **방이 비었을 때**다. 채널 보관이 성공했는지에 기대지 않는다.
- 릴레이가 내려갈 때는 SIGTERM 깃발(`AppState.shutting_down`)을 보고, 그 뒤에 끝나는 세션과 서버가 멈춘 뒤에도 남은 세션을 `shutdown`으로 마무리한다(최대 10초 기다림).
  하드 종료 시간을 넘기면 `manifest.json`이 안 남을 수 있다 — 작업기의 "10분 규칙"이 처리한다.
- 메시에서 방 주인이 바뀌면 옛 주인 쪽 세션이 끝나고 새 주인 쪽에서 새 세션이 시작된다. 허들 하나가 세션 여러 개로 나뉠 수 있다.
- 로그에 소리 내용을 남기지 않는다.

## 작업기가 지킬 것

- `manifest.json`이 생긴 세션만 처리한다. 마지막 조각 뒤로 오래(예: 10분) `manifest.json`이 안 생기면(파드가 죽음) 조각만으로 마무리한다.
- 같은 세션을 두 번 처리하지 않는다(노션 "허들 ID"·세션 ID로 막는다).
- 한 허들(`channel_id`)에 세션이 여러 개면(메시 주인 변경, 릴레이 롤링 배포, 6시간 넘김) `started_at` 순서로 이어 붙여 회의록 하나로 만든다.
  주인이 바뀌는 순간 두 파드가 아주 잠깐 같이 녹음할 수 있으니, 이어 붙일 때 겹치는 구간은 한쪽만 쓴다.
- **세션 하나가 끝났다고 회의가 끝난 게 아니다.** `room_empty`·`shutdown`은 그 세션이 끝났다는 뜻일 뿐이다.
  회의 끝은 부모 채널의 허들 종료 이벤트(48103)나 채널 보관, 또는 마지막 `manifest.json` 뒤로 일정 시간(예: 10분) 새 세션이 없을 때로 판단한다.
- 녹음 원본과 섞은 오디오는 이 버킷에만 둔다. 버킷 전체에 15일 삭제 규칙이 걸려 있다. 스크립트 JSON은 이 버킷에 두지 않는다.
