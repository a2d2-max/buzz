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
//!    그 앞에 [`correct`] 가 문맥으로 잘못 들은 낱말을 고친다(원본은 그대로).
//! 8. [`notion`] 은 회의록 페이지를 노션 DB 에 쓴다.
//!
//! 사람 이름: [`profiles`] 가 회의마다 한 번 릴레이에서 참석자 프로필(kind 0)을 물어
//! 붙인다. 못 찾은 사람은 pubkey 앞 8자.
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
pub mod chirp;
pub mod collect;
pub mod correct;
pub mod diarize;
pub mod followup;
pub mod gcs_minutes;
pub mod ledger;
pub mod media;
pub mod models;
pub mod notion;
pub mod pipeline;
pub mod profiles;
pub mod runner;
pub mod sim;
pub mod sim_room;
pub mod speaker_check;
pub mod speakers;
pub mod store;
pub mod stt;
pub mod summary;
#[cfg(test)]
mod test_http;
pub mod tracks;
pub mod transcript;
pub mod vad;
pub mod voices;
