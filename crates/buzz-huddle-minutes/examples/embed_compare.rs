//! 목소리 특징 모델 비교(측정만). 숫자만 찍는다(글·특징 값 없음).
//!
//! - KconfSpeech 세션(`--kconf <wav 폴더>=<세션 JSON>`): 발화 파일마다 특징 → 같은 세션 안 같은/다른 화자 짝
//!   코사인 분포와 EER. 같은 화자의 연속 발화를 약 10초씩 묶어 평균 낸 "짧은 묶음" 끼리도 잰다.
//! - 실제 녹음(`--real-wav`, `--real-lines`, `--real-map`): 줄마다 특징 → 같은/다른 사람 줄 짝 분포,
//!   이름표(묶음)끼리 평균 코사인과 줄 짝 평균 코사인.
//!
//! ```text
//! cargo run -p buzz-huddle-minutes --example embed_compare -- --out x.json \
//!   --kconf <폴더>=<json> --real-wav mixed.wav --real-lines report.json --real-map "회의실 화자 1=A,..."
//! ```

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Instant;

use anyhow::Context;
use buzz_huddle_minutes::audio::read_wav_mono_i16;
use buzz_huddle_minutes::diarize::{cosine, weighted_mean, ModelId, SherpaEmbedder, VoiceEmbedder};
use buzz_huddle_minutes::models::{model_path, SPEAKER_EMBEDDING_CANDIDATES};
use clap::Parser;
use serde::Serialize;

#[derive(Parser, Debug)]
struct Args {
    /// 결과 JSON.
    #[arg(long)]
    out: PathBuf,
    /// `<wav 폴더>=<세션 JSON>` (여러 번).
    #[arg(long)]
    kconf: Vec<String>,
    /// 실제 녹음의 섞은 소리(16kHz WAV).
    #[arg(long)]
    real_wav: Option<PathBuf>,
    /// 실제 녹음 줄(`speaker_report` 결과 JSON 의 lines).
    #[arg(long)]
    real_lines: Option<PathBuf>,
    /// 이름표=사람 (`-` 는 빼기), 쉼표로.
    #[arg(long)]
    real_map: Option<String>,
    /// 잴 모델(파일 이름). 없으면 후보 전부.
    #[arg(long, value_delimiter = ',')]
    models: Vec<String>,
}

/// 특징과 무게(초) 목록.
type Weighted = Vec<(Vec<f32>, f32)>;
/// 모으는 중인 묶음: (세션, 화자, 특징들, 합친 초).
type OpenChunk = (usize, usize, Weighted, f32);

#[derive(Serialize, Default, Clone)]
struct Pairs {
    same: usize,
    different: usize,
    same_median: f32,
    same_p10: f32,
    different_median: f32,
    different_p90: f32,
    eer: f32,
}

fn pct(sorted: &[f32], q: f32) -> f32 {
    if sorted.is_empty() {
        return f32::NAN;
    }
    sorted[((sorted.len() - 1) as f32 * q).round() as usize]
}

fn pairs_of(items: &[(usize, Vec<f32>)]) -> Pairs {
    pairs_pooled(&[items])
}

/// 묶음(세션)마다 안에서만 짝을 짓고, 코사인을 모두 모아 잰다.
fn pairs_pooled(groups: &[&[(usize, Vec<f32>)]]) -> Pairs {
    let (mut same, mut different) = (Vec::new(), Vec::new());
    for items in groups {
        for i in 0..items.len() {
            for j in i + 1..items.len() {
                let s = cosine(&items[i].1, &items[j].1);
                if items[i].0 == items[j].0 {
                    same.push(s);
                } else {
                    different.push(s);
                }
            }
        }
    }
    let cmp = |a: &f32, b: &f32| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal);
    same.sort_by(cmp);
    different.sort_by(cmp);
    // EER: threshold where "same below" equals "different at or above".
    let mut eer = 1.0f32;
    let mut best_gap = f32::MAX;
    for k in 0..=200 {
        let t = -1.0 + k as f32 * 0.01;
        let frr = same.iter().filter(|&&s| s < t).count() as f32 / same.len().max(1) as f32;
        let far =
            different.iter().filter(|&&s| s >= t).count() as f32 / different.len().max(1) as f32;
        if (frr - far).abs() < best_gap {
            best_gap = (frr - far).abs();
            eer = (frr + far) / 2.0;
        }
    }
    Pairs {
        same: same.len(),
        different: different.len(),
        same_median: pct(&same, 0.5),
        same_p10: pct(&same, 0.1),
        different_median: pct(&different, 0.5),
        different_p90: pct(&different, 0.9),
        eer,
    }
}

#[derive(Serialize)]
struct RealResult {
    /// (이름표 a, 이름표 b, 같은 사람인가, 평균끼리 코사인, 줄 짝 평균 코사인).
    labels: Vec<(String, String, bool, f32, f32)>,
    lines: Pairs,
}

#[derive(Serialize)]
struct ModelResult {
    model: String,
    seconds: f64,
    kconf_utterances: Pairs,
    kconf_chunks_10s: Pairs,
    real: Option<RealResult>,
}

fn main() -> anyhow::Result<()> {
    let args = Args::parse();
    let cache = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(".cache");
    // KconfSpeech: (session, speaker index, seconds, pcm), in file order.
    let mut utterances: Vec<(usize, usize, f32, Vec<f32>)> = Vec::new();
    for (session, spec) in args.kconf.iter().enumerate() {
        let (dir, json) = spec.split_once('=').context("--kconf <폴더>=<json>")?;
        let dir = PathBuf::from(dir);
        let name = dir
            .file_name()
            .and_then(|n| n.to_str())
            .context("session folder")?
            .to_string();
        let data: serde_json::Value = serde_json::from_slice(&std::fs::read(json)?)?;
        let mut speaker_of: HashMap<String, String> = HashMap::new();
        for d in data["dataSet"]["dialogs"].as_array().context("dialogs")? {
            let path = d["audioPath"].as_str().unwrap_or_default();
            let parts: Vec<&str> = path.split('/').collect();
            if parts.len() >= 2 && parts[parts.len() - 2] == name {
                speaker_of.insert(
                    parts[parts.len() - 1].to_string(),
                    d["speaker"].as_str().unwrap_or_default().to_string(),
                );
            }
        }
        let mut files: Vec<PathBuf> = std::fs::read_dir(&dir)?
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.extension().and_then(|x| x.to_str()) == Some("wav"))
            .collect();
        files.sort();
        let mut speakers: Vec<String> = Vec::new();
        for path in files {
            let file = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or_default();
            let Some(who) = speaker_of.get(file) else {
                continue;
            };
            let (rate, pcm) = read_wav_mono_i16(&std::fs::read(&path)?)?;
            anyhow::ensure!(rate == 16_000, "16 kHz only");
            let index = match speakers.iter().position(|s| s == who) {
                Some(i) => i,
                None => {
                    speakers.push(who.clone());
                    speakers.len() - 1
                }
            };
            let seconds = pcm.len() as f32 / 16_000.0;
            utterances.push((session, index, seconds, pcm));
        }
    }
    // Real recording lines: (person, label, pcm).
    let mut real_lines: Vec<(String, String, Vec<f32>)> = Vec::new();
    if let (Some(wav), Some(lines), Some(map)) = (&args.real_wav, &args.real_lines, &args.real_map)
    {
        let (rate, pcm) = read_wav_mono_i16(&std::fs::read(wav)?)?;
        anyhow::ensure!(rate == 16_000, "16 kHz only");
        let mapping: HashMap<String, String> = map
            .split(',')
            .filter_map(|kv| kv.split_once('='))
            .map(|(k, v)| (k.trim().to_string(), v.trim().to_string()))
            .collect();
        let data: serde_json::Value = serde_json::from_slice(&std::fs::read(lines)?)?;
        for line in data["lines"].as_array().context("lines")? {
            let label = line["speaker_label"]
                .as_str()
                .unwrap_or_default()
                .to_string();
            let Some(person) = mapping.get(&label).filter(|p| *p != "-") else {
                continue;
            };
            let a = line["start_ms"].as_u64().unwrap_or(0) as usize * 16;
            let b = (line["end_ms"].as_u64().unwrap_or(0) as usize * 16).min(pcm.len());
            if b > a {
                real_lines.push((person.clone(), label, pcm[a..b].to_vec()));
            }
        }
    }

    let models: Vec<_> = SPEAKER_EMBEDDING_CANDIDATES
        .iter()
        .filter(|m| args.models.is_empty() || args.models.iter().any(|n| n == m.file))
        .collect();
    let mut results = Vec::new();
    for model in models {
        let started = Instant::now();
        let embedder = SherpaEmbedder::new(&model_path(&cache, model), ModelId::from(model), 4)?;
        // Utterances (≥ 1 s) and ~10 s chunks of one speaker's consecutive utterances.
        let mut by_session_utt: HashMap<usize, Vec<(usize, Vec<f32>)>> = HashMap::new();
        let mut by_session_chunk: HashMap<usize, Vec<(usize, Vec<f32>)>> = HashMap::new();
        let mut open: Option<OpenChunk> = None;
        for (session, speaker, seconds, pcm) in &utterances {
            if *seconds < 1.0 {
                continue;
            }
            let Some(e) = embedder.embed(pcm)? else {
                continue;
            };
            by_session_utt
                .entry(*session)
                .or_default()
                .push((*speaker, e.clone()));
            match open.as_mut() {
                Some((s, k, items, total)) if *s == *session && *k == *speaker => {
                    items.push((e, *seconds));
                    *total += seconds;
                }
                _ => {
                    if let Some((s, k, items, total)) = open.take() {
                        if total >= 8.0 {
                            if let Some(m) = weighted_mean(&items) {
                                by_session_chunk.entry(s).or_default().push((k, m));
                            }
                        }
                    }
                    open = Some((*session, *speaker, vec![(e, *seconds)], *seconds));
                }
            }
            if let Some((s, k, items, total)) = open.as_ref() {
                if *total >= 10.0 {
                    if let Some(m) = weighted_mean(items) {
                        by_session_chunk.entry(*s).or_default().push((*k, m));
                    }
                    open = None;
                }
            }
        }
        let merge_pairs = |groups: &HashMap<usize, Vec<(usize, Vec<f32>)>>| {
            let lists: Vec<&[(usize, Vec<f32>)]> = groups.values().map(|v| &v[..]).collect();
            pairs_pooled(&lists)
        };
        let kconf_utterances = merge_pairs(&by_session_utt);
        let kconf_chunks_10s = merge_pairs(&by_session_chunk);
        let real = if real_lines.is_empty() {
            None
        } else {
            let mut people: Vec<String> = Vec::new();
            let mut items: Vec<(usize, Vec<f32>)> = Vec::new();
            let mut by_label: HashMap<String, (String, Weighted)> = HashMap::new();
            for (person, label, pcm) in &real_lines {
                if pcm.len() < 16_000 {
                    continue;
                }
                let Some(e) = embedder.embed(pcm)? else {
                    continue;
                };
                let p = match people.iter().position(|x| x == person) {
                    Some(i) => i,
                    None => {
                        people.push(person.clone());
                        people.len() - 1
                    }
                };
                items.push((p, e.clone()));
                by_label
                    .entry(label.clone())
                    .or_insert_with(|| (person.clone(), Vec::new()))
                    .1
                    .push((e, pcm.len() as f32 / 16_000.0));
            }
            let mut labels: Vec<&String> = by_label.keys().collect();
            labels.sort();
            let mut rows = Vec::new();
            for i in 0..labels.len() {
                for j in i + 1..labels.len() {
                    let (pa, ea) = &by_label[labels[i]];
                    let (pb, eb) = &by_label[labels[j]];
                    let (Some(ma), Some(mb)) = (weighted_mean(ea), weighted_mean(eb)) else {
                        continue;
                    };
                    let mut pair_sum = 0.0;
                    let mut n = 0;
                    for (x, _) in ea {
                        for (y, _) in eb {
                            pair_sum += cosine(x, y);
                            n += 1;
                        }
                    }
                    rows.push((
                        labels[i].clone(),
                        labels[j].clone(),
                        pa == pb,
                        cosine(&ma, &mb),
                        pair_sum / n.max(1) as f32,
                    ));
                }
            }
            Some(RealResult {
                labels: rows,
                lines: pairs_of(&items),
            })
        };
        let seconds = started.elapsed().as_secs_f64();
        eprintln!(
            "{} | {:.0}s | kconf utt EER {:.3} (same med {:.3}, diff med {:.3}) | 10s chunks EER {:.3} (same med {:.3}, diff med {:.3})",
            model.file,
            seconds,
            kconf_utterances.eer,
            kconf_utterances.same_median,
            kconf_utterances.different_median,
            kconf_chunks_10s.eer,
            kconf_chunks_10s.same_median,
            kconf_chunks_10s.different_median
        );
        if let Some(real) = &real {
            for (a, b, same, centroid, pairwise) in &real.labels {
                eprintln!(
                    "   real {a} vs {b}: same person {same} | means {centroid:.3} | line pairs {pairwise:.3}"
                );
            }
            eprintln!(
                "   real lines: same {} med {:.3} | diff {} med {:.3} | EER {:.3}",
                real.lines.same,
                real.lines.same_median,
                real.lines.different,
                real.lines.different_median,
                real.lines.eer
            );
        }
        results.push(ModelResult {
            model: model.file.to_string(),
            seconds,
            kconf_utterances,
            kconf_chunks_10s,
            real,
        });
    }
    std::fs::write(&args.out, serde_json::to_vec_pretty(&results)?)?;
    Ok(())
}
