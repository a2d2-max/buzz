#![deny(unsafe_code)]
#![warn(missing_docs)]
//! Huddle minutes worker (stage 2, `docs/huddle-minutes-worker.md`).
//!
//! Reads what the relay recorder wrote (`docs/huddle-recording.md`) and
//! produces a Korean script of who said what and when
//! (`huddle-transcript/1`) plus one mixed audio file for playback.
//!
//! 1. [`collect`] gathers a huddle's sessions in `started_at` order.
//! 2. [`tracks`] decodes each person's Opus onto one meeting clock.
//! 3. [`vad`] finds speech and cuts it into pieces.
//! 4. [`stt`] is where the transcriber plugs in.
//! 5. [`transcript`] is the script format; [`pipeline`] runs 2–6.
//! 6. [`audio`] mixes everyone into the playback file.
//!
//! [`sim`] builds fake recordings with an answer sheet and [`check`]
//! compares a script against it.
//!
//! 화자: [`speakers`] 가 파이프라인에 끼우는 자리 하나다. [`diarize`] 는 트랙 안 화자
//! 나누기(B), [`bleed`] 는 새는 소리(A), [`voices`] 는 누가 누군지와 목소리 프로필(C).
//! [`sim_room`] 은 회의실 마이크 가짜 회의, [`speaker_check`] 는 그 정답 대조.

pub mod audio;
pub mod bleed;
pub mod check;
pub mod collect;
pub mod diarize;
pub mod ledger;
pub mod media;
pub mod models;
pub mod pipeline;
pub mod runner;
pub mod sim;
pub mod sim_room;
pub mod speaker_check;
pub mod speakers;
pub mod store;
pub mod stt;
pub mod tracks;
pub mod transcript;
pub mod vad;
pub mod voices;
