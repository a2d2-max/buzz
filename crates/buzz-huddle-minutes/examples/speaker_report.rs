//! 녹음 폴더 하나를 화자 단계까지 돌려 화자 보고(숫자만)와 줄(시각·이름표)을 JSON 으로 남긴다.
//! 받아쓰기는 대역 글. 실제 녹음에서 묶음끼리 목소리 거리·묶음별 말 길이를 볼 때 쓴다.
//!
//! ```text
//! cargo run -p buzz-huddle-minutes --example speaker_report -- --recordings <폴더> --community <id> \
//!   --channel <id> --out <결과.json> [--merge-threshold 0.7 | --no-merge]
//! ```

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Context;
use buzz_huddle_minutes::collect::collect_meetings;
use buzz_huddle_minutes::diarize::{DiarizerSettings, ModelId, SherpaDiarizer, SherpaEmbedder};
use buzz_huddle_minutes::ledger::SttLedger;
use buzz_huddle_minutes::models::{
    model_path, silero_vad_path, SPEAKER_EMBEDDING, SPEAKER_SEGMENTATION,
};
use buzz_huddle_minutes::pipeline::{build_minutes, MinutesSettings, SttPolicy};
use buzz_huddle_minutes::speakers::SpeakerSettings;
use buzz_huddle_minutes::store::LocalStore;
use buzz_huddle_minutes::stt::{SpeechToText, SttError, SttOutput, SttRequest};
use buzz_huddle_minutes::transcript::SttInfo;
use buzz_huddle_minutes::vad::{SegmentPlan, SileroSettings, SileroVad};
use clap::Parser;
use uuid::Uuid;

#[derive(Parser, Debug)]
struct Args {
    #[arg(long)]
    recordings: PathBuf,
    #[arg(long, default_value = "huddles")]
    prefix: String,
    #[arg(long)]
    community: Uuid,
    #[arg(long)]
    channel: Uuid,
    #[arg(long)]
    out: PathBuf,
    #[arg(long, default_value_t = buzz_huddle_minutes::diarize::DEFAULT_CLUSTER_THRESHOLD)]
    cluster_threshold: f32,
    #[arg(long)]
    merge_threshold: Option<f32>,
    #[arg(long)]
    no_merge: bool,
}

struct Placeholder;

impl SpeechToText for Placeholder {
    fn info(&self) -> SttInfo {
        SttInfo {
            engine: "placeholder".into(),
            region: "local".into(),
            language: "ko-KR".into(),
            billed_seconds: 0,
        }
    }

    async fn transcribe(&self, _: SttRequest<'_>) -> Result<SttOutput, SttError> {
        Ok(SttOutput {
            text: String::new(),
            billed_seconds: 0,
        })
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> anyhow::Result<()> {
    let args = Args::parse();
    let cache = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(".cache");
    let store = LocalStore::new(&args.recordings);
    let mut meetings =
        collect_meetings(&store, &args.prefix, args.community, args.channel, 600_000)
            .await?
            .meetings;
    let meeting = meetings.pop().context("no meeting")?;
    let embedding = model_path(&cache, &SPEAKER_EMBEDDING);
    let speakers = SpeakerSettings {
        diarizer: Some(Arc::new(SherpaDiarizer::new(
            &model_path(&cache, &SPEAKER_SEGMENTATION),
            &embedding,
            DiarizerSettings {
                threshold: args.cluster_threshold,
                num_threads: 2,
                ..DiarizerSettings::default()
            },
        )?)),
        embedder: Some(Arc::new(SherpaEmbedder::new(
            &embedding,
            ModelId::from(&SPEAKER_EMBEDDING),
            2,
        )?)),
        merge_threshold: if args.no_merge {
            None
        } else {
            args.merge_threshold
                .or(buzz_huddle_minutes::speakers::DEFAULT_MERGE_THRESHOLD)
        },
        ..SpeakerSettings::default()
    };
    let settings = MinutesSettings {
        segment_plan: SegmentPlan::default(),
        stt: SttPolicy::default(),
        ledger_version: "speaker-report".into(),
        audio_key: String::new(),
        now_unix_ms: 0,
        speakers,
    };
    let mut detector = SileroVad::new(&silero_vad_path(&cache), SileroSettings::default())?;
    let output = build_minutes(
        &meeting,
        &mut detector,
        &Placeholder,
        &mut SttLedger::in_memory(),
        &settings,
    )
    .await?;
    let lines: Vec<serde_json::Value> = output
        .transcript
        .segments
        .iter()
        .map(|s| {
            serde_json::json!({
                "start_ms": s.start_ms, "end_ms": s.end_ms,
                "device": &s.device[..8], "speaker_label": s.speaker_label,
            })
        })
        .collect();
    let report = &output.report.speakers_split;
    std::fs::write(
        &args.out,
        serde_json::to_vec_pretty(&serde_json::json!({
            "merge_threshold": settings.speakers.merge_threshold,
            "cluster_threshold": args.cluster_threshold,
            "report": report,
            "lines": lines,
        }))?,
    )?;
    for track in &report.tracks {
        eprintln!(
            "track {}: speakers {} | raw clusters (ms) {:?} | folded {} merged {} | similarity {:?}",
            &track.device[..8],
            track.speakers,
            track.raw_cluster_ms,
            track.folded_clusters,
            track.merged_clusters,
            track
                .cluster_similarity
                .iter()
                .map(|(a, b, s)| format!("{a}-{b}:{s:.3}"))
                .collect::<Vec<_>>()
        );
    }
    Ok(())
}
