//! 받아쓰기 측정: 소리 하나(16 kHz mono wav)를 덩어리마다 진짜 Chirp 3(작업기의 `ChirpStt`)에 보내
//! 결과를 줄마다 jsonl 로 덧붙인다(끊겨도 받은 것은 남고, 다시 돌리면 남은 것만 보낸다).
//!
//! 덩어리는 둘 중 하나로 정한다.
//! - `--pieces <json>`: 이미 정한 덩어리(`{"pieces":[{"audio":[a,b],"speech":[s,e]}, …]}`, 샘플 번호).
//!   켜고 끈 두 조건을 같은 덩어리로 견줄 때.
//! - `--plan-vad`: 작업기와 같은 Silero VAD + 덩어리 자르기(`--vad-level on` 이면 VAD 만 크기 맞춘
//!   사본을 본다). 자른 덩어리는 `--out` 옆 `.pieces.json` 에 남긴다.
//!
//! 돈: 요청마다 매긴 초를 `--spend` 장부에 적고, 합이 `--max-usd` 를 넘을 요청은 보내지 않는다
//! (분당 0.016달러). 결과에 글이 들어가므로 저장소 밖(`.cache/`)에만 쓴다.
//!
//! ```text
//! cargo run --example chirp_pieces -- --wav S000018-orig.wav --pieces S000018-orig.json \
//!   --word-times on --project a2d2-lab --out .cache/cmethod/kconf/words-S000018.jsonl
//! ```

use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::Context;
use buzz_gcp::token::{TokenSource, Tokens};
use buzz_huddle_minutes::audio::read_wav_mono_i16;
use buzz_huddle_minutes::chirp::ChirpStt;
use buzz_huddle_minutes::speakers::OnOff;
use buzz_huddle_minutes::stt::{SpeechToText, SttRequest};
use buzz_huddle_minutes::vad::{
    level_for_vad_above, plan_segments, SegmentPlan, SileroSettings, SileroVad, SpeechDetector,
    VAD_LEVEL_FLOOR_DBFS, VAD_SAMPLE_RATE,
};
use clap::Parser;
use futures_util::stream::{self, StreamExt};
use serde::Deserialize;
use serde_json::json;

const USD_PER_MINUTE: f64 = 0.016;

#[derive(Debug, Parser)]
struct Args {
    /// 16 kHz mono 16-bit wav.
    #[arg(long)]
    wav: PathBuf,
    /// 정해 둔 덩어리(json). 없으면 `--plan-vad`.
    #[arg(long)]
    pieces: Option<PathBuf>,
    /// 작업기 VAD 로 덩어리를 자른다.
    #[arg(long)]
    plan_vad: bool,
    /// VAD 만 크기 맞춘 사본을 본다(`--plan-vad` 일 때).
    #[arg(long, value_enum, default_value_t = OnOff::Off)]
    vad_level: OnOff,
    /// 크기 맞춤 바닥(dBFS, 이보다 조용한 창은 안 올린다). 기본은 작업기 값.
    #[arg(long, allow_negative_numbers = true, default_value_t = VAD_LEVEL_FLOOR_DBFS)]
    vad_floor: f32,
    /// 덩어리만 자르고(`.pieces.json`) Chirp 에는 보내지 않는다.
    #[arg(long)]
    plan_only: bool,
    /// silero_vad.onnx 가 든 폴더(models/ 아래).
    #[arg(long)]
    cache: Option<PathBuf>,
    /// 단어 시각을 묻는다.
    #[arg(long, value_enum, default_value_t = OnOff::Off)]
    word_times: OnOff,
    /// GCP 프로젝트(gcloud 로그인 토큰, 이 프로젝트로 매김).
    #[arg(long)]
    project: String,
    /// 결과(jsonl, 덩어리마다 한 줄).
    #[arg(long)]
    out: PathBuf,
    /// 돈 장부(jsonl).
    #[arg(long)]
    spend: PathBuf,
    /// 이 장부 합이 넘으면 더 보내지 않는다(달러).
    #[arg(long)]
    max_usd: f64,
    /// 한꺼번에 보내는 요청 수.
    #[arg(long, default_value_t = 6)]
    jobs: usize,
}

#[derive(Deserialize)]
struct PieceSet {
    pieces: Vec<PieceJson>,
}

#[derive(Deserialize, serde::Serialize, Clone, Copy)]
struct PieceJson {
    audio: [usize; 2],
    speech: [usize; 2],
}

fn spent(path: &Path) -> f64 {
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .filter_map(|row| row["usd"].as_f64())
        .sum()
}

fn plan(
    pcm: &[f32],
    cache: &Path,
    vad_level: bool,
    floor_dbfs: f32,
) -> anyhow::Result<Vec<PieceJson>> {
    let model = cache.join("models/silero_vad.onnx");
    let mut detector = SileroVad::new(&model, SileroSettings::default())
        .map_err(|e| anyhow::anyhow!("silero: {e}"))?;
    let leveled = vad_level.then(|| level_for_vad_above(pcm, floor_dbfs));
    let heard: &[f32] = leveled.as_deref().unwrap_or(pcm);
    let spans = detector.detect(heard)?;
    let pieces = plan_segments(
        &spans,
        VAD_SAMPLE_RATE,
        pcm.len(),
        &SegmentPlan::default(),
        |unit| {
            let inner = detector.detect_pauses(&heard[unit.start..unit.end])?;
            Ok(inner
                .into_iter()
                .map(|span| buzz_huddle_minutes::vad::SpeechSpan {
                    start: unit.start + span.start,
                    end: unit.start + span.end,
                })
                .collect())
        },
    )?;
    Ok(pieces
        .into_iter()
        .map(|p| PieceJson {
            audio: [p.audio.start, p.audio.end],
            speech: [p.speech.start, p.speech.end],
        })
        .collect())
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = Args::parse();
    let bytes = std::fs::read(&args.wav).with_context(|| args.wav.display().to_string())?;
    let (rate, pcm) = read_wav_mono_i16(&bytes).map_err(|e| anyhow::anyhow!("wav: {e}"))?;
    anyhow::ensure!(rate == VAD_SAMPLE_RATE, "need 16 kHz, got {rate}");
    let pieces: Vec<PieceJson> = match (&args.pieces, args.plan_vad) {
        (Some(path), false) => serde_json::from_slice::<PieceSet>(&std::fs::read(path)?)?.pieces,
        (None, true) => {
            let cache = args.cache.as_deref().context("--plan-vad needs --cache")?;
            let pieces = plan(&pcm, cache, args.vad_level == OnOff::On, args.vad_floor)?;
            let saved = args.out.with_extension("pieces.json");
            std::fs::write(&saved, serde_json::to_vec(&json!({ "pieces": pieces }))?)?;
            if args.plan_only {
                eprintln!("{} pieces → {}", pieces.len(), saved.display());
                return Ok(());
            }
            pieces
        }
        _ => anyhow::bail!("give --pieces or --plan-vad"),
    };
    let done: std::collections::HashSet<usize> = std::fs::read_to_string(&args.out)
        .unwrap_or_default()
        .lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .filter(|row| row.get("error").is_none())
        .filter_map(|row| row["i"].as_u64().map(|i| i as usize))
        .collect();
    let todo: Vec<(usize, PieceJson)> = pieces
        .iter()
        .copied()
        .enumerate()
        .filter(|(i, _)| !done.contains(i))
        .collect();
    let planned_usd: f64 = todo
        .iter()
        .map(|(_, p)| ((p.audio[1] - p.audio[0]) as f64 / 16_000.0).ceil() / 60.0 * USD_PER_MINUTE)
        .sum();
    eprintln!(
        "{} pieces, {} done, {} to send ({planned_usd:.3} USD planned, {:.3} spent so far)",
        pieces.len(),
        done.len(),
        todo.len(),
        spent(&args.spend)
    );
    anyhow::ensure!(
        spent(&args.spend) + planned_usd <= args.max_usd,
        "over budget: {:.3} + {planned_usd:.3} > {}",
        spent(&args.spend),
        args.max_usd
    );
    let tokens = Tokens::new(TokenSource::gcloud())?;
    let stt = ChirpStt::new(tokens, &args.project, Some(args.project.clone()))
        .map_err(anyhow::Error::msg)?;
    let word_times = args.word_times == OnOff::On;
    let mut out = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&args.out)?;
    let mut spend = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&args.spend)?;
    let pcm = &pcm;
    let stt = &stt;
    let mut answers = stream::iter(todo)
        .map(|(i, p)| async move {
            let request = SttRequest {
                speaker: "measure",
                start_ms: p.audio[0] as u64 / 16,
                end_ms: p.audio[1] as u64 / 16,
                pcm_16k: &pcm[p.audio[0]..p.audio[1]],
                word_times,
            };
            (i, p, stt.transcribe(request).await)
        })
        .buffer_unordered(args.jobs.max(1));
    let (mut sent, mut failed, mut billed) = (0u64, 0u64, 0u64);
    while let Some((i, p, answer)) = answers.next().await {
        sent += 1;
        let row = match answer {
            Ok(output) => {
                billed += output.billed_seconds;
                writeln!(
                    spend,
                    "{}",
                    json!({"what": args.out.display().to_string(), "i": i,
                           "billed_sec": output.billed_seconds,
                           "usd": output.billed_seconds as f64 / 60.0 * USD_PER_MINUTE})
                )?;
                json!({"i": i, "audio": p.audio, "speech": p.speech, "text": output.text,
                       "words": output.words, "billed_sec": output.billed_seconds})
            }
            Err(error) => {
                failed += 1;
                json!({"i": i, "audio": p.audio, "speech": p.speech, "error": error.to_string()})
            }
        };
        writeln!(out, "{row}")?;
    }
    eprintln!(
        "sent {sent}, failed {failed}, billed {billed} s, spent so far {:.3} USD",
        spent(&args.spend)
    );
    Ok(())
}
