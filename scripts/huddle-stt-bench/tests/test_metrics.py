from huddle_stt_bench.metrics import char_errors, drop_parenthesized, edit_distance, normalize


def test_drop_parenthesized_for_reference_cer():
    ref = "코차모 밸리(Cochamó Valley) - 남아메리카의 문서（75.6 cm x 62.2 cm）는"
    assert normalize(drop_parenthesized(ref), keep_spaces=False) == "코차모밸리남아메리카의문서는"


def test_normalize_drops_punct_and_spaces():
    assert normalize("안녕하세요, 반갑습니다!", keep_spaces=False) == "안녕하세요반갑습니다"
    assert normalize("  안녕하세요,   반갑습니다! ", keep_spaces=True) == "안녕하세요 반갑습니다"


def test_normalize_nfkc_composes_jamo_and_fullwidth():
    # 풀어 쓴 자모(NFD)와 전각 숫자는 NFKC 로 같은 글자가 된다
    import unicodedata

    assert normalize(unicodedata.normalize("NFD", "한국"), keep_spaces=False) == "한국"
    assert normalize("３시", keep_spaces=False) == "3시"


def test_quotes_from_fleurs_raw_are_removed():
    assert normalize('"한 목격자는 ""무정부""상태로', keep_spaces=False) == "한목격자는무정부상태로"


def test_numbers_are_not_rewritten():
    # 숫자 표기 차이는 고치지 않고 오류로 센다
    edits, n = char_errors("세 시에 만나", "3시에 만나", keep_spaces=False)
    assert (edits, n) == (1, 5)


def test_spacing_counts_only_in_space_cer():
    assert char_errors("오늘 회의", "오늘회의", keep_spaces=False) == (0, 4)
    assert char_errors("오늘 회의", "오늘회의", keep_spaces=True) == (1, 5)


def test_zero_width_chars_are_removed():
    # U+200B 폭 없는 공백, U+FEFF BOM, U+200D 폭 없는 이음 — 모두 범주 Cf
    assert normalize("회​의﻿록‍", keep_spaces=False) == "회의록"


def test_percent_is_kept():
    assert normalize("물가가 3% 올랐다.", keep_spaces=False) == "물가가3%올랐다"
    assert normalize("３％", keep_spaces=False) == "3%"  # 전각도 NFKC 로 같아진다
    assert char_errors("3% 올랐다", "3 올랐다", keep_spaces=False) == (1, 5)


def test_decimal_point_kept_only_between_digits():
    assert normalize("75.6 cm, 62.2 cm.", keep_spaces=False) == "75.6cm62.2cm"
    assert normalize("끝났다. 3.", keep_spaces=False) == "끝났다3"
    assert normalize(".5 와 5.", keep_spaces=False) == "5와5"


def test_thousands_separator_is_removed():
    assert normalize("1,000명", keep_spaces=False) == "1000명"
    assert char_errors("1,000명", "1000명", keep_spaces=False) == (0, 5)


def test_edit_distance_basic():
    assert edit_distance("", "") == 0
    assert edit_distance("abc", "") == 3
    assert edit_distance("", "ab") == 2
    assert edit_distance("kitten", "sitting") == 3
    assert edit_distance("회의록", "회의 록") == 1
