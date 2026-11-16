"""Zeroth-Korean(OpenSLR 40, CC BY 4.0) parquet 를 화자 id 가 붙은 WAV 묶음으로 푼다.

화자 분리를 재려면 "누가 말했는지" 가 붙은 한국어 소리가 있어야 한다. FLEURS 한국어에는
화자 id 가 없어서 이걸 쓴다. 받은 곳은 Hugging Face `kresnik/zeroth_korean`
(OpenSLR 40 을 parquet 로 옮긴 것, 화자 id 가 들어 있음)이다.

    python3 -I zeroth_to_wav.py <parquet> <나갈 폴더> [화자마다 최대 몇 개]

나가는 것: `<폴더>/audio/<id>.wav`(16kHz 모노 16비트)와 `<폴더>/manifest.jsonl`
(`{"id","audio","text","speaker","source"}` 한 줄에 하나). 데이터 원문은 커밋하지 않는다
(`.cache/` 아래에만 둔다).
"""

import io
import json
import sys
import wave
from collections import defaultdict
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq
import soundfile as sf

SOURCE = "kresnik/zeroth_korean (OpenSLR 40 Zeroth-Korean, CC BY 4.0)"


def main() -> None:
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    parquet = Path(sys.argv[1])
    out = Path(sys.argv[2])
    per_speaker = int(sys.argv[3]) if len(sys.argv) > 3 else 10**9
    (out / "audio").mkdir(parents=True, exist_ok=True)
    table = pq.read_table(parquet, columns=["id", "speaker_id", "text", "audio"])
    taken: dict[int, int] = defaultdict(int)
    lines = []
    for row in table.to_pylist():
        speaker = int(row["speaker_id"])
        if taken[speaker] >= per_speaker:
            continue
        pcm, rate = sf.read(io.BytesIO(row["audio"]["bytes"]), dtype="int16")
        if rate != 16_000:
            sys.exit(f"{row['id']}: {rate} Hz, 16000 이어야 한다")
        if pcm.ndim > 1:
            pcm = pcm.mean(axis=1).astype(np.int16)
        name = f"audio/{row['id']}.wav"
        with wave.open(str(out / name), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(16_000)
            w.writeframes(pcm.tobytes())
        taken[speaker] += 1
        lines.append(
            {
                "id": row["id"],
                "audio": name,
                "text": row["text"],
                "speaker": str(speaker),
                "source": SOURCE,
            }
        )
    with open(out / "manifest.jsonl", "w", encoding="utf-8") as f:
        for line in lines:
            f.write(json.dumps(line, ensure_ascii=False) + "\n")
    print(f"{len(lines)} 개, 화자 {len(taken)} 명 → {out}")


if __name__ == "__main__":
    main()
