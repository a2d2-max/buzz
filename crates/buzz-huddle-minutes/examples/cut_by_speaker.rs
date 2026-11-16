//! 측정용: 소리 하나(16 kHz mono wav)와 그 VAD 덩어리에 작업기와 같은 화자 나누기(분할 + 군집 0.9 + 작은 묶음
//! 버리기 + 두 번째 합치기 0.7)를 돌리고, 덩어리를 화자가 바뀌는 자리에서 자른 토막(A 방식으로 보낼 조각이자
//! C 방식에서 단어를 나눠 줄 화자 토막)을 json 으로 쓴다. 같은 화자 나누기 결과로 A·C 를 견주려고 쓴다.
//!
//! ```text
//! cargo run --example cut_by_speaker -- --wav S000018-orig.wav --pieces S000018-orig.json \
//!   --out .cache/cmethod/ac/S000018.subs.json
//! ```
//!
//! 나오는 것: `{"speakers": n, "subs": [{"audio":[a,b], "speech":[s,e], "speaker":k|null, "share":x,
//! "piece":i}]}`(샘플 번호, `piece` 는 원래 덩어리 순번).

use std::path::PathBuf;

use anyhow::Context;
use buzz_huddle_minutes::audio::read_wav_mono_i16;
use buzz_huddle_minutes::diarize::{
    cut_pieces, merge_similar, speech_per_speaker, squeeze, CutSettings, DiarizerSettings, ModelId,
    SherpaDiarizer, SherpaEmbedder, TrackDiarizer, Turn,
};
use buzz_huddle_minutes::models::{model_path, SPEAKER_EMBEDDING, SPEAKER_SEGMENTATION};
use buzz_huddle_minutes::speakers::{SpeakerSettings, DEFAULT_MERGE_THRESHOLD};
use buzz_huddle_minutes::vad::{Piece, SpeechSpan};
use clap::Parser;
use serde::Deserialize;
use serde_json::json;

#[derive(Debug, Parser)]
struct Args {
    /// 16 kHz mono 16-bit wav.
    #[arg(long)]
    wav: PathBuf,
    /// VAD 덩어리(`{"pieces":[{"audio":[a,b],"speech":[s,e]}]}`).
    #[arg(long)]
    pieces: PathBuf,
    /// 모델 폴더가 든 곳(`models/` 아래).
    #[arg(long)]
    cache: PathBuf,
    /// 결과 json.
    #[arg(long)]
    out: PathBuf,
}

#[derive(Deserialize)]
struct PieceSet {
    pieces: Vec<PieceJson>,
}

#[derive(Deserialize)]
struct PieceJson {
    audio: [usize; 2],
    speech: [usize; 2],
}

fn main() -> anyhow::Result<()> {
    let args = Args::parse();
    let bytes = std::fs::read(&args.wav).with_context(|| args.wav.display().to_string())?;
    let (_, pcm) = read_wav_mono_i16(&bytes).map_err(|e| anyhow::anyhow!("wav: {e}"))?;
    let set: PieceSet = serde_json::from_slice(&std::fs::read(&args.pieces)?)?;
    let pieces: Vec<Piece> = set
        .pieces
        .iter()
        .map(|p| Piece {
            speech: SpeechSpan {
                start: p.speech[0],
                end: p.speech[1],
            },
            audio: SpeechSpan {
                start: p.audio[0],
                end: p.audio[1],
            },
        })
        .collect();
    let settings = SpeakerSettings::default();
    let segmentation = model_path(&args.cache, &SPEAKER_SEGMENTATION);
    let embedding = model_path(&args.cache, &SPEAKER_EMBEDDING);
    let diarizer = SherpaDiarizer::new(
        &segmentation,
        &embedding,
        DiarizerSettings {
            num_threads: 4,
            ..DiarizerSettings::default()
        },
    )?;
    let embedder = SherpaEmbedder::new(&embedding, ModelId::from(&SPEAKER_EMBEDDING), 4)?;
    let ms = |ms: u64| (ms * 16) as usize;
    // The same steps as `MeetingSpeakers::split`.
    let spans: Vec<SpeechSpan> = pieces.iter().map(|p| p.audio).collect();
    let squeezed = squeeze(&pcm, &spans, ms(settings.squeeze_gap_ms));
    let found = squeezed.turns_to_track(&diarizer.diarize(&squeezed.pcm)?);
    let per = speech_per_speaker(&found);
    let floor = ms(settings.min_cluster_ms);
    let keep: Vec<usize> = (0..per.len()).filter(|&s| per[s] >= floor).collect();
    let mut turns: Vec<Turn> = found
        .into_iter()
        .filter_map(|t| {
            let local = keep.iter().position(|&k| k == t.speaker)?;
            Some(Turn {
                speaker: local,
                ..t
            })
        })
        .collect();
    let mut speakers = keep.len();
    if speakers >= 2 {
        if let Some(threshold) = DEFAULT_MERGE_THRESHOLD {
            let (merged_turns, merged, _) = merge_similar(
                &turns,
                &pcm,
                &embedder,
                threshold,
                ms(settings.embed_min_piece_ms),
                ms(settings.embed_max_ms),
            )?;
            turns = merged_turns;
            speakers -= merged;
        }
    }
    let cut = if speakers >= 2 {
        cut_pieces(&pieces, &turns, &pcm, &CutSettings::default())
    } else {
        Vec::new()
    };
    let subs: Vec<serde_json::Value> = cut
        .iter()
        .map(|sub| {
            let piece = pieces.iter().position(|p| {
                p.speech.start <= sub.piece.speech.start && sub.piece.speech.end <= p.speech.end
            });
            json!({
                "audio": [sub.piece.audio.start, sub.piece.audio.end],
                "speech": [sub.piece.speech.start, sub.piece.speech.end],
                "speaker": sub.speaker,
                "share": sub.share,
                "piece": piece,
            })
        })
        .collect();
    eprintln!(
        "{} pieces → {} speakers, {} speaker pieces",
        pieces.len(),
        speakers,
        subs.len()
    );
    std::fs::write(
        &args.out,
        serde_json::to_vec(&json!({"speakers": speakers, "subs": subs}))?,
    )?;
    Ok(())
}
