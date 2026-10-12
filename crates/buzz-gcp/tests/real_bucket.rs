//! One round trip on the real bucket with the developer machine's gcloud
//! token. Writes one `test/<uuid>.txt`, deletes exactly that name, and
//! checks `test/` is empty afterwards.
//!
//! `cargo test -p buzz-gcp --test real_bucket -- --ignored --nocapture`

use buzz_gcp::gcs::{Gcs, GcsErrorKind, Write};
use buzz_gcp::token::{TokenSource, Tokens};

const BUCKET: &str = "a2d2-huddle-minutes";

#[tokio::test]
#[ignore = "needs network and a gcloud login that can write gs://a2d2-huddle-minutes/test/"]
async fn real_bucket_round_trip() {
    let gcs = Gcs::new(Tokens::new(TokenSource::gcloud()).expect("tokens")).expect("client");
    let name = format!("test/{}.txt", uuid::Uuid::new_v4());
    let body = format!("buzz-gcp round trip {name}").into_bytes();

    let steps = async {
        let written = gcs
            .put(BUCKET, &name, body.clone(), "text/plain", Write::IfAbsent)
            .await
            .map_err(|e| format!("put: {e}"))?;
        eprintln!("put {name}: generation {}", written.generation);
        let read = gcs
            .get(BUCKET, &name)
            .await
            .map_err(|e| format!("get: {e}"))?;
        if read != body {
            return Err("get: other bytes".to_string());
        }
        eprintln!("get: {} bytes, same", read.len());
        let listed = gcs
            .list(BUCKET, "test/")
            .await
            .map_err(|e| format!("list: {e}"))?;
        let found = listed
            .iter()
            .find(|object| object.name == name)
            .ok_or("list: not there")?;
        if found.generation != written.generation {
            return Err("list: other generation".to_string());
        }
        eprintln!(
            "list test/: {} object(s), ours with the same generation",
            listed.len()
        );
        match gcs
            .put(BUCKET, &name, b"x".to_vec(), "text/plain", Write::IfAbsent)
            .await
        {
            Err(error) if error.kind == GcsErrorKind::AlreadyExists => {
                eprintln!("put again only-if-absent: {error}");
            }
            other => return Err(format!("put again: {other:?}")),
        }
        if gcs
            .get(BUCKET, &name)
            .await
            .map_err(|e| format!("get: {e}"))?
            != body
        {
            return Err("put again changed the object".to_string());
        }
        Ok(())
    }
    .await;

    // Exactly the one object this test wrote, whatever happened above.
    let deleted = gcs.delete(BUCKET, &name).await;
    steps.expect("round trip");
    deleted.expect("delete");
    eprintln!("deleted {name}");
    let left = gcs.list(BUCKET, "test/").await.expect("list");
    assert!(left.is_empty(), "{} object(s) left under test/", left.len());
    eprintln!("list test/: empty");
}
