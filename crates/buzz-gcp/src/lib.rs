#![deny(unsafe_code)]
#![warn(missing_docs)]
//! Google Cloud access shared by the huddle recorder (`buzz-relay`) and the
//! minutes worker (`buzz-huddle-minutes`):
//!
//! - [`token`]: where access tokens come from (the metadata server on GCE,
//!   GKE and Cloud Run; `gcloud` on a developer machine; a fixed token in
//!   tests), each kept until shortly before it expires;
//! - [`gcs`]: Cloud Storage through the JSON API — list a prefix, read an
//!   object (whole or its first bytes), write one (optionally only if it
//!   does not exist yet) and delete one by its exact name.
//!
//! Tokens never show up in logs or errors: [`token::AccessToken`] prints as
//! `***`, and errors carry the HTTP status and Google's message only.

pub mod gcs;
pub mod token;
