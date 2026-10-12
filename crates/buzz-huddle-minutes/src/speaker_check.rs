//! 회의실 가짜 회의([`crate::sim_room`])의 정답과 스크립트를 대조한다.
//!
//! - **DER**(화자 분리 오류율): 회의실 트랙에서 10ms 칸마다 정답 화자(깨끗한 소리에서 찾은
//!   말 단위)와 스크립트 줄의 화자 묶음("회의실 화자 N")을 견준다. 묶음 ↔ 사람 짝은 겹친 시간이
//!   가장 많아지게 하나씩 짓는다. DER = (놓침 + 헛잡음 + 다른 사람) / 정답 말 시간.
//!   여유 구간(collar) 없이 잰다. "겹침 제외"는 정답에서 두 사람 이상이 말하는 칸을 빼고 잰 것.
//!   에코는 회의실 사람의 말이 아니므로 정답에 없다(남으면 헛잡음).
//! - **문장 묶음 맞음**: 회의실 문장마다 가장 많이 덮은 묶음이 그 사람과 짝인가.
//! - **문장 이름 맞음**: 회의실 문장마다 가장 많이 덮은 줄의 `speaker` 가 그 사람 pubkey 인가
//!   (맞음 / 다른 사람(잘못) / null("회의실 화자 N"으로 남음) / 줄 없음).
//! - **1인 트랙 쪼갬**: 원격(자기 기기) 트랙인데 화자가 둘 이상으로 나뉜 수.
//! - **두 번 나온 문장**: 정답 문장 글이 둘 이상의 줄에 나온 수(에코가 남으면 생긴다).
//!   받아쓰기 대역은 300ms 만 겹쳐도 문장 글을 통째로 주므로, 진짜 말 밑에 작게 깔린 에코도
//!   두 번으로 센다(실제보다 나쁘게 잰다). 그래서 시간으로 센 것도 같이 낸다:
//!   **에코가 주인인 줄** = 남은 회의실 줄 가운데 에코와 300ms 이상 겹치고, 그 줄 안에서
//!   에코 시간이 진짜 말 시간보다 긴 것(에코마다 한 번).
//! - **진짜 말을 잘못 지움**: 새는 소리·두 번 잡힘으로 뺀 덩어리 가운데 절반 넘게 그 트랙의
//!   진짜 말(에코 아님)이었던 것.

use std::collections::{HashMap, HashSet};

use serde::Serialize;

use crate::sim_room::{RoomTruth, Seat};
use crate::speakers::SpeakersReport;
use crate::transcript::Transcript;

/// DER 의 몫들(ms).
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize)]
pub struct DerParts {
    /// 정답 말 시간(겹친 칸은 사람 수만큼).
    pub reference_ms: u64,
    /// 놓친 말.
    pub miss_ms: u64,
    /// 헛잡은 말.
    pub false_alarm_ms: u64,
    /// 다른 사람으로 붙은 말.
    pub confusion_ms: u64,
}

impl DerParts {
    /// 오류율.
    pub fn der(&self) -> f64 {
        if self.reference_ms == 0 {
            return 0.0;
        }
        (self.miss_ms + self.false_alarm_ms + self.confusion_ms) as f64 / self.reference_ms as f64
    }

    /// 더한다.
    pub fn add(&mut self, other: &DerParts) {
        self.reference_ms += other.reference_ms;
        self.miss_ms += other.miss_ms;
        self.false_alarm_ms += other.false_alarm_ms;
        self.confusion_ms += other.confusion_ms;
    }
}

/// 이름 맞추기 셈.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct NamingCounts {
    /// 그 사람 pubkey.
    pub right: usize,
    /// 다른 사람 pubkey(더 나쁜 것).
    pub wrong: usize,
    /// null("회의실 화자 N").
    pub unnamed: usize,
    /// 덮은 줄이 없음.
    pub missed: usize,
}

impl NamingCounts {
    /// 더한다.
    pub fn add(&mut self, other: &NamingCounts) {
        self.right += other.right;
        self.wrong += other.wrong;
        self.unnamed += other.unnamed;
        self.missed += other.missed;
    }

    /// 전체.
    pub fn total(&self) -> usize {
        self.right + self.wrong + self.unnamed + self.missed
    }
}

/// 대조 결과(한 회의 또는 여럿을 더한 것).
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct SpeakerScore {
    /// 회의 수.
    pub meetings: usize,
    /// 회의실 트랙 DER(겹침 포함).
    pub room_der: DerParts,
    /// 회의실 트랙 DER(겹침 제외).
    pub room_der_no_overlap: DerParts,
    /// 회의실 문장 수.
    pub room_sentences: usize,
    /// 묶음이 맞은 회의실 문장.
    pub room_sentences_grouped_right: usize,
    /// 덮은 줄이 없는 회의실 문장.
    pub room_sentences_missed: usize,
    /// 회의실 문장 이름: 프로필(또는 같은 회의 깨끗한 트랙)이 있는 사람.
    pub naming_known: NamingCounts,
    /// 회의실 문장 이름: 프로필이 없는 사람.
    pub naming_unknown: NamingCounts,
    /// 회의실 기기 주인이 아닌데 주인 pubkey 가 붙은 회의실 문장. 목소리로 주인을 맞힌 묶음에
    /// 화자 나누기가 남의 문장을 섞어 넣은 것도 센다(저절로 준 것만 세는 값이 아니다).
    pub room_owner_given_by_device: usize,
    /// 원격(자기 기기) 트랙 수.
    pub own_tracks: usize,
    /// 그 가운데 화자가 둘 이상으로 나뉜 것.
    pub own_tracks_split: usize,
    /// 원격 문장 수.
    pub own_sentences: usize,
    /// 그 가운데 그 사람 pubkey 로 붙은 것.
    pub own_sentences_right: usize,
    /// 둘 이상의 줄에 글이 나온 정답 문장.
    pub duplicated_sentences: usize,
    /// 에코 수.
    pub echoes: usize,
    /// 에코가 주인인 채로 남은 회의실 줄이 있는 에코 수.
    pub echoes_left_dominant: usize,
    /// 낱말이 하나라도 그 트랙 줄 어디에도 없는 정답 문장(에코 빼고). 받아쓰기 대역이 낱말을 그대로
    /// 주니, 0 이 아니면 잘못 지운 말이 있다는 뜻이다.
    pub sentences_lost: usize,
    /// 낱말은 다 있지만 한 줄에 다 들어 있지 않은 문장(C 방식: 겹쳐 말한 곳 등에서 문장이 화자 둘로
    /// 나뉜 것).
    pub sentences_split: usize,
    /// 뺀 덩어리 수(새는 소리 + 두 번 잡힘).
    pub removed_pieces: usize,
    /// 그 가운데 진짜 말이 절반 넘던 것.
    pub removed_real_pieces: usize,
    /// 뺀 진짜 말 시간(ms).
    pub removed_real_ms: u64,
}

impl SpeakerScore {
    /// 더한다.
    pub fn add(&mut self, other: &SpeakerScore) {
        self.meetings += other.meetings;
        self.room_der.add(&other.room_der);
        self.room_der_no_overlap.add(&other.room_der_no_overlap);
        self.room_sentences += other.room_sentences;
        self.room_sentences_grouped_right += other.room_sentences_grouped_right;
        self.room_sentences_missed += other.room_sentences_missed;
        self.naming_known.add(&other.naming_known);
        self.naming_unknown.add(&other.naming_unknown);
        self.room_owner_given_by_device += other.room_owner_given_by_device;
        self.own_tracks += other.own_tracks;
        self.own_tracks_split += other.own_tracks_split;
        self.own_sentences += other.own_sentences;
        self.own_sentences_right += other.own_sentences_right;
        self.duplicated_sentences += other.duplicated_sentences;
        self.echoes += other.echoes;
        self.echoes_left_dominant += other.echoes_left_dominant;
        self.sentences_lost += other.sentences_lost;
        self.sentences_split += other.sentences_split;
        self.removed_pieces += other.removed_pieces;
        self.removed_real_pieces += other.removed_real_pieces;
        self.removed_real_ms += other.removed_real_ms;
    }
}

const FRAME_MS: u64 = 10;

/// 줄이 누구로 붙었나: 회의실 줄은 이름표, 그 밖은 pubkey.
fn identity(label: Option<&String>, speaker: Option<&String>) -> String {
    label
        .or(speaker)
        .cloned()
        .unwrap_or_else(|| "?".to_string())
}

fn overlap(a: (u64, u64), b: (u64, u64)) -> u64 {
    a.1.min(b.1).saturating_sub(a.0.max(b.0))
}

/// 겹친 시간이 가장 많아지게 묶음(행) ↔ 사람(열)을 하나씩 짝짓는다(사람 수 ≤ 16).
fn best_mapping(matrix: &[Vec<u64>], people: usize) -> Vec<Option<usize>> {
    let hyps = matrix.len();
    let states = 1usize << people;
    // best[i][mask]: most overlap using rows i.. with people in `mask` taken.
    let mut best = vec![vec![0u64; states]; hyps + 1];
    let mut choice = vec![vec![None; states]; hyps + 1];
    for i in (0..hyps).rev() {
        for mask in 0..states {
            let mut value = best[i + 1][mask];
            let mut pick = None;
            for (r, &m) in matrix[i].iter().enumerate() {
                if mask & (1 << r) == 0 && m > 0 {
                    let v = m + best[i + 1][mask | (1 << r)];
                    if v > value {
                        value = v;
                        pick = Some(r);
                    }
                }
            }
            best[i][mask] = value;
            choice[i][mask] = pick;
        }
    }
    let mut out = vec![None; hyps];
    let mut mask = 0usize;
    for (i, slot) in out.iter_mut().enumerate() {
        if let Some(r) = choice[i][mask] {
            *slot = Some(r);
            mask |= 1 << r;
        }
    }
    out
}

/// `transcript` 를 `truth` 와 견준다. `known` 은 이 회의 때 프로필(또는 같은 회의 깨끗한
/// 트랙)이 있던 사람 pubkey, `report` 는 그 회의의 화자 단계 보고.
pub fn score_room_meeting(
    transcript: &Transcript,
    truth: &RoomTruth,
    report: &SpeakersReport,
    known: &HashSet<String>,
) -> SpeakerScore {
    let mut score = SpeakerScore {
        meetings: 1,
        echoes: truth.echoes.len(),
        ..SpeakerScore::default()
    };
    let lines = &transcript.segments;

    if let Some(room) = &truth.room_device {
        let room_lines: Vec<(String, (u64, u64), Option<&String>)> = lines
            .iter()
            .filter(|l| &l.device == room)
            .map(|l| {
                (
                    identity(l.speaker_label.as_ref(), l.speaker.as_ref()),
                    (l.start_ms, l.end_ms),
                    l.speaker.as_ref(),
                )
            })
            .collect();
        let room_people: Vec<&str> = truth
            .people
            .iter()
            .filter(|p| matches!(p.seat, Seat::Room { .. }))
            .map(|p| p.pubkey.as_str())
            .collect();
        let sentences: Vec<_> = truth
            .utterances
            .iter()
            .filter(|u| &u.device == room)
            .collect();
        let mut hyps: Vec<String> = room_lines.iter().map(|l| l.0.clone()).collect();
        hyps.sort();
        hyps.dedup();
        let frames = usize::try_from(truth.duration_ms / FRAME_MS + 1).unwrap_or(0);
        // Who is talking in each frame, by the answer sheet and by the script.
        let mut reference: Vec<Vec<usize>> = vec![Vec::new(); frames];
        for u in &sentences {
            let Some(r) = room_people.iter().position(|p| *p == u.person) else {
                continue;
            };
            for &[a, b] in &u.speech_units_ms {
                for f in (a / FRAME_MS)..(b / FRAME_MS).min(frames as u64) {
                    let cell = &mut reference[f as usize];
                    if !cell.contains(&r) {
                        cell.push(r);
                    }
                }
            }
        }
        let mut hypothesis: Vec<Vec<usize>> = vec![Vec::new(); frames];
        for (who, (a, b), _) in &room_lines {
            let h = hyps.iter().position(|x| x == who).unwrap_or(0);
            for f in (a / FRAME_MS)..(b / FRAME_MS).min(frames as u64) {
                let cell = &mut hypothesis[f as usize];
                if !cell.contains(&h) {
                    cell.push(h);
                }
            }
        }
        let mut matrix = vec![vec![0u64; room_people.len()]; hyps.len()];
        for (refs, hyp) in reference.iter().zip(&hypothesis) {
            for &h in hyp {
                for &r in refs {
                    matrix[h][r] += FRAME_MS;
                }
            }
        }
        let mapping = best_mapping(&matrix, room_people.len());
        for (refs, hyp) in reference.iter().zip(&hypothesis) {
            let (n_ref, n_hyp) = (refs.len() as u64, hyp.len() as u64);
            let correct = hyp
                .iter()
                .filter(|&&h| mapping[h].is_some_and(|r| refs.contains(&r)))
                .count() as u64;
            let parts = DerParts {
                reference_ms: n_ref * FRAME_MS,
                miss_ms: n_ref.saturating_sub(n_hyp) * FRAME_MS,
                false_alarm_ms: n_hyp.saturating_sub(n_ref) * FRAME_MS,
                confusion_ms: (n_ref.min(n_hyp) - correct.min(n_ref.min(n_hyp))) * FRAME_MS,
            };
            score.room_der.add(&parts);
            if n_ref < 2 {
                score.room_der_no_overlap.add(&parts);
            }
        }
        // Sentence by sentence.
        for u in &sentences {
            score.room_sentences += 1;
            let units: Vec<(u64, u64)> = u.speech_units_ms.iter().map(|&[a, b]| (a, b)).collect();
            let mut by_identity: HashMap<&str, u64> = HashMap::new();
            let mut by_line: Vec<(u64, Option<&String>)> = Vec::new();
            for (who, span, speaker) in &room_lines {
                let covered: u64 = units.iter().map(|&unit| overlap(unit, *span)).sum();
                if covered > 0 {
                    *by_identity.entry(who.as_str()).or_default() += covered;
                    by_line.push((covered, *speaker));
                }
            }
            let counts = if known.contains(&u.person) {
                &mut score.naming_known
            } else {
                &mut score.naming_unknown
            };
            let Some((&top, _)) = by_identity.iter().max_by_key(|(id, ms)| (**ms, *id)) else {
                score.room_sentences_missed += 1;
                counts.missed += 1;
                continue;
            };
            let h = hyps.iter().position(|x| x == top);
            let r = room_people.iter().position(|p| *p == u.person);
            if h.and_then(|h| mapping[h]) == r && r.is_some() {
                score.room_sentences_grouped_right += 1;
            }
            // The name the most-covering identity carries.
            let named = room_lines
                .iter()
                .find(|(who, _, _)| who == top)
                .and_then(|(_, _, speaker)| *speaker);
            match named {
                Some(p) if *p == u.person => counts.right += 1,
                Some(p) => {
                    counts.wrong += 1;
                    if truth.room_owner.as_ref() == Some(p) {
                        score.room_owner_given_by_device += 1;
                    }
                }
                None => counts.unnamed += 1,
            }
        }
    }

    // One-person tracks.
    for person in truth.people.iter().filter(|p| p.seat == Seat::Remote) {
        score.own_tracks += 1;
        if report
            .tracks
            .iter()
            .any(|t| t.device == person.device && t.speakers >= 2)
        {
            score.own_tracks_split += 1;
        }
        for u in truth
            .utterances
            .iter()
            .filter(|u| u.person == person.pubkey)
        {
            score.own_sentences += 1;
            let best = lines
                .iter()
                .filter(|l| l.device == person.device)
                .map(|l| (overlap((u.start_ms, u.end_ms), (l.start_ms, l.end_ms)), l))
                .filter(|(ms, _)| *ms > 0)
                .max_by_key(|(ms, _)| *ms);
            if best.is_some_and(|(_, l)| l.speaker.as_ref() == Some(&person.pubkey)) {
                score.own_sentences_right += 1;
            }
        }
    }

    // Echoes still the main sound of a kept room line.
    for echo in &truth.echoes {
        let real_units: Vec<(u64, u64)> = truth
            .utterances
            .iter()
            .filter(|u| u.device == echo.device)
            .flat_map(|u| u.speech_units_ms.iter().map(|&[a, b]| (a, b)))
            .collect();
        let dominant = lines.iter().filter(|l| l.device == echo.device).any(|l| {
            let span = (l.start_ms, l.end_ms);
            let echo_ms = overlap(span, (echo.start_ms, echo.end_ms));
            let real_ms: u64 = real_units.iter().map(|&u| overlap(span, u)).sum();
            echo_ms >= 300 && echo_ms > real_ms
        });
        if dominant {
            score.echoes_left_dominant += 1;
        }
    }

    // Text: twice, split, or gone. Words are taken from the track's lines as
    // sentences use them, so a word two sentences share is not counted twice.
    let mut pool: HashMap<(&str, &str), usize> = HashMap::new();
    for l in lines.iter() {
        for word in l.text.split_whitespace() {
            *pool.entry((l.device.as_str(), word)).or_default() += 1;
        }
    }
    let mut by_time: Vec<_> = truth.utterances.iter().collect();
    by_time.sort_by_key(|u| u.start_ms);
    for u in by_time {
        let holders = lines.iter().filter(|l| l.text.contains(&u.text)).count();
        if holders >= 2 {
            score.duplicated_sentences += 1;
        }
        let mut whole = true;
        for word in u.text.split_whitespace() {
            match pool.get_mut(&(u.device.as_str(), word)) {
                Some(n) if *n > 0 => *n -= 1,
                _ => whole = false,
            }
        }
        if !whole {
            score.sentences_lost += 1;
        } else if holders == 0 {
            score.sentences_split += 1;
        }
    }

    // Removed pieces that were real speech of their track.
    let mut removed: Vec<(String, u64, u64)> = report
        .tracks
        .iter()
        .flat_map(|t| {
            t.bleed_spans_ms
                .iter()
                .map(move |&(a, b)| (t.device.clone(), a, b))
        })
        .collect();
    removed.extend(report.duplicate_spans_ms.iter().cloned());
    for (device, a, b) in removed {
        score.removed_pieces += 1;
        let real: u64 = truth
            .utterances
            .iter()
            .filter(|u| u.device == device)
            .flat_map(|u| u.speech_units_ms.iter())
            .map(|&[x, y]| overlap((a, b), (x, y)))
            .sum();
        if real * 2 > b - a {
            score.removed_real_pieces += 1;
        }
        score.removed_real_ms += real;
    }
    score
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mapping_takes_the_largest_total_overlap() {
        // Row 0 overlaps person 0 a lot, row 1 overlaps person 0 a bit more
        // than person 1: the best total gives row 1 person 1.
        let matrix = vec![vec![900, 10], vec![300, 200], vec![0, 0]];
        assert_eq!(best_mapping(&matrix, 2), [Some(0), Some(1), None]);
    }

    #[test]
    fn der_parts() {
        let parts = DerParts {
            reference_ms: 1_000,
            miss_ms: 100,
            false_alarm_ms: 50,
            confusion_ms: 50,
        };
        assert!((parts.der() - 0.2).abs() < 1e-9);
    }
}
