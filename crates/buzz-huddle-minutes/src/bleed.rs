//! 새는 소리 지우기 (A, 가볍게).
//!
//! 남은 경우는 하나다: 원격 참가자 소리가 회의실 스피커로 나와 회의실 마이크에 다시
//! 들어간 것(앱 에코 제거가 놓친 것). 그 소리는 원격 참가자 자기 트랙에 더 크게, 조금
//! 먼저 있다. 그래서 받아쓰기 덩어리마다
//!
//! - 같은 시각 다른 트랙의 소리 크기(10ms 로그 에너지) 흐름과 상관을 재고
//!   (다른 트랙이 0~[`BleedSettings::max_lag_ms`] 먼저인 범위에서 가장 높은 값),
//! - 상관이 [`BleedSettings::min_correlation`] 이상이고 다른 트랙이
//!   [`BleedSettings::min_louder_db`] 이상 크면 "새어 든 소리"로 보고 받아쓰기에 보내지 않는다.
//!
//! 두 사람이 정말 동시에 다른 말을 하면 소리 크기 흐름이 달라 상관이 낮다(지우지 않는다).
//! 진짜 말 위에 에코가 겹친 덩어리도 상관이 낮아져 남는다 — 잘못 지우기보다 두 번 남는 쪽을 고른다.

/// 10ms 한 칸.
pub const ENVELOPE_FRAME_MS: u64 = 10;

/// 한 트랙의 10ms 소리 크기(dB) 흐름.
#[derive(Debug, Clone, PartialEq)]
pub struct Envelope {
    /// 첫 칸의 회의 시각(ms).
    pub start_ms: u64,
    /// 칸마다 `10·log10(평균 제곱 + 1e-10)`.
    pub db: Vec<f32>,
}

impl Envelope {
    /// `pcm`(`rate` Hz, 첫 샘플이 회의 시각 `start_ms`)의 흐름.
    pub fn of(pcm: &[f32], rate: u32, start_ms: u64) -> Self {
        let frame = usize::try_from(u64::from(rate) * ENVELOPE_FRAME_MS / 1_000)
            .unwrap_or(1)
            .max(1);
        Self {
            start_ms,
            db: pcm
                .chunks(frame)
                .map(|chunk| {
                    let energy = chunk.iter().map(|x| x * x).sum::<f32>() / chunk.len() as f32;
                    10.0 * (energy + 1e-10).log10()
                })
                .collect(),
        }
    }

    /// 회의 시각 `[from_ms, to_ms)` 의 칸들(트랙 밖은 무음 값으로 채운다).
    fn window(&self, from_ms: i64, to_ms: i64) -> Vec<f32> {
        let start = i64::try_from(self.start_ms).unwrap_or(i64::MAX);
        let frame = ENVELOPE_FRAME_MS as i64;
        let silent = -100.0;
        (from_ms.div_euclid(frame)..to_ms.div_euclid(frame))
            .map(|f| {
                let at = f * frame - start;
                if at < 0 {
                    return silent;
                }
                usize::try_from(at / frame)
                    .ok()
                    .and_then(|i| self.db.get(i).copied())
                    .unwrap_or(silent)
            })
            .collect()
    }
}

/// A 의 기준.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BleedSettings {
    /// 켜고 끄기.
    pub enabled: bool,
    /// 다른 트랙이 이만큼까지 먼저일 수 있다(ms). 원격 소리가 회의실 스피커로 나와 다시
    /// 잡히기까지 네트워크·재생 버퍼만큼 늦는다.
    pub max_lag_ms: u64,
    /// 상관이 이 이상이면 같은 소리로 본다.
    pub min_correlation: f32,
    /// 다른 트랙이 이만큼 이상 커야 이쪽을 지운다(dB).
    pub min_louder_db: f32,
}

impl Default for BleedSettings {
    fn default() -> Self {
        // 잰 값과 까닭은 docs/huddle-minutes-worker.md "새는 소리" 표.
        Self {
            enabled: true,
            max_lag_ms: 400,
            min_correlation: 0.8,
            min_louder_db: 3.0,
        }
    }
}

/// 한 덩어리를 새어 든 소리로 본 근거(숫자만).
#[derive(Debug, Clone, PartialEq)]
pub struct BleedVerdict {
    /// 원래 소리가 있던 트랙 순번(`others` 안).
    pub source: usize,
    /// 그 트랙보다 이만큼 늦다(ms).
    pub lag_ms: u64,
    /// 가장 높은 상관.
    pub correlation: f32,
    /// 그 트랙이 이만큼 크다(dB).
    pub louder_db: f32,
}

/// `this`(이 트랙)의 회의 시각 `[from_ms, to_ms)` 덩어리가 `others` 가운데 하나에서 새어 든
/// 소리인가. 가장 상관이 높은 트랙 하나만 본다.
pub fn find_bleed(
    this: &Envelope,
    from_ms: u64,
    to_ms: u64,
    others: &[&Envelope],
    settings: &BleedSettings,
) -> Option<BleedVerdict> {
    if !settings.enabled || to_ms <= from_ms + 3 * ENVELOPE_FRAME_MS {
        return None;
    }
    let from = i64::try_from(from_ms).ok()?;
    let to = i64::try_from(to_ms).ok()?;
    let own = this.window(from, to);
    let own_energy = mean_energy_db(&own);
    let mut best: Option<BleedVerdict> = None;
    for (index, other) in others.iter().enumerate() {
        let mut step = 0;
        while step * ENVELOPE_FRAME_MS <= settings.max_lag_ms {
            let lag = i64::try_from(step * ENVELOPE_FRAME_MS).ok()?;
            let theirs = other.window(from - lag, to - lag);
            if let Some(r) = pearson(&own, &theirs) {
                if best.as_ref().is_none_or(|b| r > b.correlation) {
                    best = Some(BleedVerdict {
                        source: index,
                        lag_ms: step * ENVELOPE_FRAME_MS,
                        correlation: r,
                        louder_db: mean_energy_db(&theirs) - own_energy,
                    });
                }
            }
            step += 1;
        }
    }
    best.filter(|b| {
        b.correlation >= settings.min_correlation && b.louder_db >= settings.min_louder_db
    })
}

/// dB 칸들의 평균 에너지(dB).
fn mean_energy_db(db: &[f32]) -> f32 {
    if db.is_empty() {
        return -100.0;
    }
    let mean = db.iter().map(|d| 10f32.powf(d / 10.0)).sum::<f32>() / db.len() as f32;
    10.0 * (mean + 1e-10).log10()
}

fn pearson(a: &[f32], b: &[f32]) -> Option<f32> {
    if a.len() != b.len() || a.len() < 3 {
        return None;
    }
    let n = a.len() as f32;
    let ma = a.iter().sum::<f32>() / n;
    let mb = b.iter().sum::<f32>() / n;
    let (mut num, mut da, mut db) = (0.0f32, 0.0f32, 0.0f32);
    for (x, y) in a.iter().zip(b) {
        num += (x - ma) * (y - mb);
        da += (x - ma) * (x - ma);
        db += (y - mb) * (y - mb);
    }
    let den = (da * db).sqrt();
    (den > 1e-6).then(|| num / den)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// "Words": bursts of noise with lengths that differ word to word.
    fn speech(seed: u64, ms: usize, level: f32) -> Vec<f32> {
        let mut state = seed;
        let mut next = move || {
            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1);
            ((state >> 33) as f32 / (1u64 << 31) as f32) - 0.5
        };
        let mut out = Vec::with_capacity(ms * 16);
        let mut t = 0;
        let mut word = 0usize;
        while t < ms {
            let on = 150 + (word * 7 + seed as usize * 13) % 250;
            let off = 60 + (word * 11 + seed as usize * 5) % 180;
            for _ in 0..on.min(ms - t) * 16 {
                out.push(next() * level);
            }
            t += on;
            let gap = off.min(ms.saturating_sub(t));
            out.extend(std::iter::repeat_n(0.0, gap * 16));
            t += gap;
            word += 1;
        }
        out.truncate(ms * 16);
        out
    }

    fn delayed(pcm: &[f32], ms: usize, gain: f32) -> Vec<f32> {
        let mut out = vec![0.0; ms * 16];
        out.extend(pcm.iter().map(|x| x * gain));
        out.truncate(pcm.len());
        out
    }

    #[test]
    fn an_echo_of_a_louder_track_is_bleed_and_other_speech_is_not() {
        let remote = speech(1, 6_000, 0.3);
        // The room mic hears the remote voice 200 ms later, 20 dB down.
        let room_echo = delayed(&remote, 200, 0.1);
        let env_remote = Envelope::of(&remote, 16_000, 1_000);
        let env_echo = Envelope::of(&room_echo, 16_000, 1_000);
        let settings = BleedSettings::default();
        let verdict =
            find_bleed(&env_echo, 1_500, 6_500, &[&env_remote], &settings).expect("echo found");
        assert_eq!(verdict.lag_ms, 200);
        assert!(verdict.correlation > 0.9, "{verdict:?}");
        assert!(verdict.louder_db > 15.0, "{verdict:?}");

        // Someone in the room really talking at the same time: kept.
        let other = speech(2, 6_000, 0.1);
        let env_other = Envelope::of(&other, 16_000, 1_000);
        assert_eq!(
            find_bleed(&env_other, 1_500, 6_500, &[&env_remote], &settings),
            None
        );
        // The louder side is never the one removed.
        assert_eq!(
            find_bleed(&env_remote, 1_500, 6_500, &[&env_echo], &settings),
            None
        );
        // Switched off: nothing.
        let off = BleedSettings {
            enabled: false,
            ..settings
        };
        assert_eq!(
            find_bleed(&env_echo, 1_500, 6_500, &[&env_remote], &off),
            None
        );
    }
}
