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
//! 4. [`stt`] is where the transcriber plugs in; [`chirp`] is Chirp 3.
//! 5. [`transcript`] is the script format; [`pipeline`] runs 2–6.
//! 6. [`audio`] mixes everyone into the playback file.
//!
//! 7. [`summary`] 는 스크립트를 Gemini 로 요약하고 지어낸 담당자·기한을 걸러 낸다.
//! 8. [`notion`] 은 회의록 페이지를 노션 DB 에 쓴다.
//!
//! [`sim`] builds fake recordings with an answer sheet and [`check`]
//! compares a script against it.

pub mod audio;
pub mod check;
pub mod chirp;
pub mod collect;
pub mod gcs_minutes;
pub mod ledger;
pub mod media;
pub mod models;
pub mod notion;
pub mod pipeline;
pub mod runner;
pub mod sim;
pub mod store;
pub mod stt;
pub mod summary;
#[cfg(test)]
mod test_http;
pub mod tracks;
pub mod transcript;
pub mod vad;
