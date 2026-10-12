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
    let max = 4_096;

    let steps = async {
        let written = gcs
            .put(BUCKET, &name, body.clone(), "text/plain", Write::IfAbsent)
            .await
            .map_err(|e| format!("put: {e}"))?;
        eprintln!("put {name}: generation {}", written.generation);
        let read = gcs
            .get(BUCKET, &name, max)
            .await
            .map_err(|e| format!("get: {e}"))?;
        if read != body {
            return Err("get: other bytes".to_string());
        }
        eprintln!("get: {} bytes, same", read.len());
        let stat = gcs
            .stat(BUCKET, &name)
            .await
            .map_err(|e| format!("stat: {e}"))?;
        if (stat.generation, stat.size) != (written.generation, body.len() as u64) {
            return Err("stat: other generation or size".to_string());
        }
        eprintln!("stat: same generation, {} bytes", stat.size);
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
        // The same bytes again only-if-absent: done, nothing written.
        let again = gcs
            .put(BUCKET, &name, body.clone(), "text/plain", Write::IfAbsent)
            .await
            .map_err(|e| format!("put same bytes again: {e}"))?;
        if again.generation != written.generation {
            return Err("put same bytes again: written twice".to_string());
        }
        eprintln!("put same bytes again only-if-absent: done, same generation");
        match gcs
            .put(BUCKET, &name, b"x".to_vec(), "text/plain", Write::IfAbsent)
            .await
        {
            Err(error) if error.kind == GcsErrorKind::AlreadyExists => {
                eprintln!("put other bytes only-if-absent: {error}");
            }
            other => return Err(format!("put other bytes: {other:?}")),
        }
        let at_generation = gcs
            .get_generation(BUCKET, &name, written.generation, max)
            .await
            .map_err(|e| format!("get at generation: {e}"))?;
        if at_generation != body {
            return Err("get at generation: other bytes".to_string());
        }
        eprintln!("get at generation: same bytes");
        match gcs
            .delete_if_generation(BUCKET, &name, written.generation + 1)
            .await
        {
            Err(error) if error.kind == GcsErrorKind::AlreadyExists => {
                eprintln!("delete at another generation: {error}");
            }
            other => return Err(format!("delete at another generation: {other:?}")),
        }
        gcs.delete_if_generation(BUCKET, &name, written.generation)
            .await
            .map_err(|e| format!("delete at its generation: {e}"))?;
        eprintln!("deleted {name} at its generation");
        Ok(())
    }
    .await;

    if let Err(failure) = steps {
        // Exactly the one object this test wrote.
        let deleted = gcs.delete(BUCKET, &name).await;
        panic!("{failure} (cleanup: {deleted:?})");
    }
    let left = gcs.list(BUCKET, "test/").await.expect("list");
    assert!(left.is_empty(), "{} object(s) left under test/", left.len());
    eprintln!("list test/: empty");
}
