//! WAV 묶음 하나를 "회의실 마이크 하나" 녹음 폴더(`buzz-huddle-recording/1`, 기기 1대)로 바꾼다.
//!
//! ```text
//! cargo run -p buzz-huddle-minutes --example wav_to_recording -- --wavs <폴더> --out <폴더>
//! ```
//!
//! 폴더 안 `*.wav`(16kHz 16비트 모노)를 파일 이름 속 번호 순서대로 고정 무음(기본 0.4초)을
//! 사이에 두고 이어 붙인다. 녹음기가 쓰는 것처럼 Opus v2 프레임·30초 조각·manifest 로 만든다
//! ([`buzz_huddle_minutes::sim_room::recording_from_tracks`]). 다 만든 뒤 `process` 에 줄 인자를
//! 찍는다. 파일 이름·소리·글은 찍지 않는다(개수와 길이만).

use std::path::PathBuf;

use anyhow::{bail, Context};
use buzz_huddle_minutes::audio::read_wav_mono_i16;
use buzz_huddle_minutes::sim::BASE_UNIX_MS;
use buzz_huddle_minutes::sim_room::recording_from_tracks;
use clap::Parser;

#[derive(Parser, Debug)]
struct Args {
    /// `*.wav` 가 든 폴더(하위 폴더는 보지 않는다).
    #[arg(long)]
    wavs: PathBuf,
    /// 녹음 폴더를 쓸 곳(`recordings/` 가 생긴다).
    #[arg(long)]
    out: PathBuf,
    /// 파일 사이 무음(ms).
    #[arg(long, default_value_t = 400)]
    gap_ms: u64,
    /// 녹음 id 를 정하는 seed.
    #[arg(long, default_value_t = 1)]
    seed: u64,
    /// 저장 접두사.
    #[arg(long, default_value = "huddles")]
    prefix: String,
}

/// 파일 이름 속 마지막 숫자 묶음.
fn number_of(name: &str) -> Option<u64> {
    let digits: String = name
        .chars()
        .rev()
        .skip_while(|c| !c.is_ascii_digit())
        .take_while(|c| c.is_ascii_digit())
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    digits.parse().ok()
}

fn main() -> anyhow::Result<()> {
    let args = Args::parse();
    let mut files: Vec<(u64, PathBuf)> = Vec::new();
    for entry in std::fs::read_dir(&args.wavs).with_context(|| "read the wav folder")? {
        let path = entry?.path();
        if path.extension().and_then(|e| e.to_str()) != Some("wav") {
            continue;
        }
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or_default()
            .to_string();
        let number = number_of(&stem).context("a wav name without a number")?;
        files.push((number, path));
    }
    files.sort();
    if files.is_empty() {
        bail!("no wav files");
    }
    let gap = usize::try_from(args.gap_ms * 16)?;
    let mut track: Vec<f32> = Vec::new();
    for (i, (_, path)) in files.iter().enumerate() {
        let (rate, pcm) = read_wav_mono_i16(&std::fs::read(path)?)?;
        if rate != 16_000 {
            bail!("file {i}: {rate} Hz, expected 16000");
        }
        if i > 0 {
            track.extend(std::iter::repeat_n(0.0, gap));
        }
        track.extend_from_slice(&pcm);
    }
    // A made-up device pubkey (32 bytes as hex).
    let device = buzz_huddle_minutes::models::sha256_hex(b"wav-room-device");
    let recording =
        recording_from_tracks(&[(device, track)], args.seed, &args.prefix, BASE_UNIX_MS)?;
    for (relative, bytes) in &recording.files {
        let path = args.out.join(relative);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&path, bytes)?;
    }
    eprintln!(
        "{} wav files joined, {:.1} min with {} ms gaps",
        files.len(),
        recording.duration_ms as f64 / 60_000.0,
        args.gap_ms
    );
    println!(
        "--recordings {} --prefix {} --community {} --channel {}",
        args.out.join("recordings").display(),
        args.prefix,
        recording.community_id,
        recording.channel_id
    );
    Ok(())
}
