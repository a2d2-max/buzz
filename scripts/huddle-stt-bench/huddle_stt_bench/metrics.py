"""글자 오류율(CER) 계산.

규칙: 유니코드 NFKC → 폭 없는 글자(범주 Cf) 제거 → 문장부호(범주 P*) 제거 → 공백 처리 → 글자 단위 편집 거리.
문장부호를 지울 때 예외 둘:
- `%` 는 남긴다. "퍼센트"로 읽히는 낱말이라서 지우면 "3%" 와 "3" 이 같아진다.
- 숫자 사이 `.` 는 소수점이라 남긴다("75.6" 이 "756" 이 되지 않게). 숫자 사이 `,`(천 단위)는 지운다("1,000" = "1000").
- 공백 뺀 CER: 공백을 모두 지운다. 띄어쓰기 차이는 오류로 안 센다.
- 공백 포함 CER: 연속 공백을 하나로 줄이고 앞뒤를 자른다. 띄어쓰기 차이도 오류로 센다.

숫자 표기("세 시" vs "3시")와 영문 대소문자는 바꾸지 않는다. 그래서 그 차이는 CER 에 섞인다.
"""

from __future__ import annotations

import re
import unicodedata

_KEEP_PUNCT = {"%"}


def drop_parenthesized(text: str) -> str:
    """괄호 안 글을 지운다. 참고값 전용: FLEURS 정답에는 읽지 않은 괄호 병기("(Cochamó Valley)")가 있다."""
    return re.sub(r"\([^)]*\)", "", unicodedata.normalize("NFKC", text))


def _keep(s: str, i: int) -> bool:
    ch = s[i]
    cat = unicodedata.category(ch)
    if cat == "Cf":
        return False
    if not cat.startswith("P") or ch in _KEEP_PUNCT:
        return True
    # 숫자 사이 소수점
    return ch == "." and 0 < i < len(s) - 1 and s[i - 1].isdigit() and s[i + 1].isdigit()


def normalize(text: str, keep_spaces: bool) -> str:
    s = unicodedata.normalize("NFKC", text)
    s = "".join(ch for i, ch in enumerate(s) if _keep(s, i))
    if keep_spaces:
        return " ".join(s.split())
    return "".join(s.split())


def edit_distance(a: str, b: str) -> int:
    """글자 단위 레벤슈타인 거리(바꿈·빠짐·끼어듦 모두 1)."""
    if len(a) < len(b):
        a, b = b, a
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def char_errors(ref: str, hyp: str, keep_spaces: bool) -> tuple[int, int]:
    """(편집 거리, 정답 글자 수). 여러 개를 합칠 때는 거리끼리·글자 수끼리 더해서 나눈다."""
    r = normalize(ref, keep_spaces)
    h = normalize(hyp, keep_spaces)
    return edit_distance(r, h), len(r)
