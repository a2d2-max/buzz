use std::io::Read;
use std::path::Path;

use nostr::{EventBuilder, Kind, Tag, Timestamp};

use crate::client::{normalize_write_response, BuzzClient};
use crate::error::CliError;

const COMMUNITY_DOC_KIND: u16 = 30_623;
const COMMUNITY_DOC_LEGACY_KIND: u16 = 30_078;
const COMMUNITY_DOC_D_PREFIX: &str = "doc:";
const COMMUNITY_DOC_TAG: &str = "community-doc";
const MAX_OPERATION_INPUT_BYTES: u64 = 2 * 1024 * 1024;

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct UnsignedDocEvent {
    kind: u16,
    content: String,
    tags: Vec<Vec<String>>,
    #[serde(rename = "createdAt")]
    created_at: u64,
}

fn valid_page_id(value: &str) -> bool {
    let mut chars = value.chars();
    matches!(chars.next(), Some(first) if first.is_ascii_alphanumeric())
        && value.len() <= 128
        && chars
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
}

fn doc_page_id(tags: &[Tag], allow_auth: bool) -> Result<&str, CliError> {
    let mut page_id = None;
    let mut d_tag_count = 0usize;
    let mut community_tag_count = 0usize;
    let mut auth_tag_count = 0usize;
    for tag in tags {
        let values = tag.as_slice();
        match values.first().map(String::as_str) {
            Some("d") if values.len() == 2 => {
                d_tag_count += 1;
                if d_tag_count > 1 {
                    return Err(CliError::Usage(
                        "Docs event must contain exactly one d tag".into(),
                    ));
                }
                page_id = values[1].strip_prefix(COMMUNITY_DOC_D_PREFIX);
            }
            Some("t") if values == ["t", COMMUNITY_DOC_TAG] => {
                community_tag_count += 1;
            }
            Some("auth") if allow_auth && values.len() == 4 => auth_tag_count += 1,
            _ => {
                return Err(CliError::Usage(
                    "Docs event contains an unsupported tag".into(),
                ));
            }
        }
    }
    let page_id = page_id
        .filter(|value| valid_page_id(value))
        .ok_or_else(|| CliError::Usage("Docs event d tag must be doc:<stable-page-id>".into()))?;
    if community_tag_count != 1 || auth_tag_count > usize::from(allow_auth) {
        return Err(CliError::Usage(
            "Docs event must contain exactly one community-doc tag and at most one auth tag".into(),
        ));
    }
    Ok(page_id)
}

fn read_bounded_input(path: &str) -> Result<String, CliError> {
    let path = Path::new(path);
    let file = std::fs::File::open(path)
        .map_err(|error| CliError::Other(format!("cannot access input: {error}")))?;
    let metadata = file
        .metadata()
        .map_err(|error| CliError::Other(format!("cannot inspect input: {error}")))?;
    if !metadata.is_file() {
        return Err(CliError::Usage("publication input must be a file".into()));
    }
    if metadata.len() == 0 || metadata.len() > MAX_OPERATION_INPUT_BYTES {
        return Err(CliError::Usage(format!(
            "publication input must be between 1 and {MAX_OPERATION_INPUT_BYTES} bytes"
        )));
    }
    let mut input = String::new();
    file.take(MAX_OPERATION_INPUT_BYTES + 1)
        .read_to_string(&mut input)
        .map_err(|error| CliError::Other(format!("could not read publication input: {error}")))?;
    if input.len() as u64 > MAX_OPERATION_INPUT_BYTES {
        return Err(CliError::Usage(format!(
            "publication input must be between 1 and {MAX_OPERATION_INPUT_BYTES} bytes"
        )));
    }
    Ok(input)
}

fn parse_unsigned_doc(path: &str) -> Result<UnsignedDocEvent, CliError> {
    let input = read_bounded_input(path)?;
    let unsigned: UnsignedDocEvent = serde_json::from_str(&input)
        .map_err(|error| CliError::Usage(format!("invalid unsigned Docs event: {error}")))?;
    if unsigned.kind != COMMUNITY_DOC_KIND {
        return Err(CliError::Usage(
            "publication signer only accepts kind 30623".into(),
        ));
    }
    if unsigned.content.len() > MAX_OPERATION_INPUT_BYTES as usize {
        return Err(CliError::Usage("Docs content is too large".into()));
    }
    let tags = unsigned
        .tags
        .iter()
        .cloned()
        .map(Tag::parse)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| CliError::Usage(format!("invalid Docs event tag: {error}")))?;
    doc_page_id(&tags, false)?;
    Ok(unsigned)
}

fn parse_signed_doc(path: &str, client: &BuzzClient) -> Result<nostr::Event, CliError> {
    let input = read_bounded_input(path)?;
    let event: nostr::Event = serde_json::from_str(&input)
        .map_err(|error| CliError::Usage(format!("invalid signed Docs event: {error}")))?;
    if event.kind != Kind::Custom(COMMUNITY_DOC_KIND) {
        return Err(CliError::Usage(
            "publication submitter only accepts kind 30623".into(),
        ));
    }
    doc_page_id(event.tags.as_slice(), true)?;
    if event.pubkey != client.keys().public_key() {
        return Err(CliError::Auth(
            "signed Docs event pubkey does not match the configured identity".into(),
        ));
    }
    event
        .verify()
        .map_err(|error| CliError::Usage(format!("invalid signed Docs event: {error}")))?;
    Ok(event)
}

fn sign_doc(path: &str, client: &BuzzClient) -> Result<nostr::Event, CliError> {
    let unsigned = parse_unsigned_doc(path)?;
    let tags = unsigned
        .tags
        .into_iter()
        .map(Tag::parse)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| CliError::Usage(format!("invalid Docs event tag: {error}")))?;
    client.sign_event(
        EventBuilder::new(Kind::Custom(COMMUNITY_DOC_KIND), unsigned.content)
            .tags(tags)
            .custom_created_at(Timestamp::from(unsigned.created_at)),
    )
}

async fn query_doc(page_id: &str, client: &BuzzClient) -> Result<String, CliError> {
    if !valid_page_id(page_id) {
        return Err(CliError::Usage("invalid Docs page ID".into()));
    }
    client
        .query(&serde_json::json!({
            "kinds": [COMMUNITY_DOC_KIND, COMMUNITY_DOC_LEGACY_KIND],
            "#d": [format!("{COMMUNITY_DOC_D_PREFIX}{page_id}")],
            "limit": 100,
        }))
        .await
}

async fn publish_doc(path: &str, client: &BuzzClient) -> Result<String, CliError> {
    let event = parse_signed_doc(path, client)?;
    let response = client.submit_event(event).await?;
    Ok(normalize_write_response(&response))
}

/// Dispatch one narrow community Docs publication bridge operation.
pub async fn dispatch(command: crate::PublicationCmd, client: &BuzzClient) -> Result<(), CliError> {
    match command {
        crate::PublicationCmd::Identity => {
            println!(
                "{}",
                serde_json::json!({
                    "relay": client.relay_url(),
                    "pubkey": client.keys().public_key().to_hex(),
                })
            );
            Ok(())
        }
        crate::PublicationCmd::QueryDoc { page_id } => {
            println!("{}", query_doc(&page_id, client).await?);
            Ok(())
        }
        crate::PublicationCmd::SignDoc { input } => {
            println!(
                "{}",
                serde_json::to_string(&sign_doc(&input, client)?)
                    .map_err(|error| CliError::Other(error.to_string()))?
            );
            Ok(())
        }
        crate::PublicationCmd::PublishDoc { input } => {
            println!("{}", publish_doc(&input, client).await?);
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use axum::extract::State;
    use axum::http::{Response, StatusCode};
    use axum::routing::post;
    use axum::Router;
    use nostr::Keys;
    use tempfile::NamedTempFile;
    use tokio::net::TcpListener;

    use super::*;

    const FIXTURE_KEY: &str = "0000000000000000000000000000000000000000000000000000000000000001";

    fn client(relay: String) -> BuzzClient {
        BuzzClient::new(
            relay,
            Keys::parse(FIXTURE_KEY).expect("fixture key"),
            None,
            None,
        )
        .expect("client")
    }

    fn write_json(value: &serde_json::Value) -> NamedTempFile {
        let mut file = NamedTempFile::new().expect("temp file");
        serde_json::to_writer(&mut file, value).expect("fixture JSON");
        file
    }

    #[test]
    fn sign_doc_accepts_only_the_production_docs_shape() {
        let input = write_json(&serde_json::json!({
            "kind": COMMUNITY_DOC_KIND,
            "content": "{\"title\":\"fixture\",\"body\":\"body\",\"parentId\":null,\"order\":0,\"createdAt\":1,\"updatedAt\":1}",
            "tags": [["d", "doc:fixture-page"], ["t", COMMUNITY_DOC_TAG]],
            "createdAt": 1,
        }));
        let client = client("http://127.0.0.1:1".into());
        let event = sign_doc(input.path().to_str().expect("path"), &client).expect("sign");
        event.verify().expect("signature");
        assert_eq!(event.kind, Kind::Custom(COMMUNITY_DOC_KIND));
        assert_eq!(
            doc_page_id(event.tags.as_slice(), true).unwrap(),
            "fixture-page"
        );

        let raw = write_json(&serde_json::json!({
            "kind": 1,
            "content": "{}",
            "tags": [["d", "doc:fixture-page"], ["t", COMMUNITY_DOC_TAG]],
            "createdAt": 1,
        }));
        assert!(sign_doc(raw.path().to_str().expect("path"), &client).is_err());

        let duplicate_d = write_json(&serde_json::json!({
            "kind": COMMUNITY_DOC_KIND,
            "content": "{}",
            "tags": [
                ["d", "not-a-doc"],
                ["d", "doc:fixture-page"],
                ["t", COMMUNITY_DOC_TAG]
            ],
            "createdAt": 1,
        }));
        assert!(sign_doc(duplicate_d.path().to_str().expect("path"), &client).is_err());
    }

    #[tokio::test]
    async fn query_doc_uses_the_current_and_legacy_kinds_on_the_real_http_client() {
        let captured = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let state = captured.clone();
        let app = Router::new()
            .route(
                "/query",
                post(
                    |State(captured): State<std::sync::Arc<std::sync::Mutex<Vec<u8>>>>,
                     body: axum::body::Bytes| async move {
                        *captured.lock().expect("capture") = body.to_vec();
                        Response::builder()
                            .status(StatusCode::OK)
                            .header("content-type", "application/json")
                            .body(Body::from("[]"))
                            .expect("response")
                    },
                ),
            )
            .with_state(state);
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let address = listener.local_addr().expect("address");
        tokio::spawn(async move {
            axum::serve(listener, app).await.expect("serve");
        });
        let client = client(format!("http://{address}"));

        assert_eq!(query_doc("fixture-page", &client).await.unwrap(), "[]");
        let body: serde_json::Value =
            serde_json::from_slice(&captured.lock().expect("capture")).expect("query JSON");
        assert_eq!(body[0]["kinds"], serde_json::json!([30_623, 30_078]));
        assert_eq!(body[0]["#d"], serde_json::json!(["doc:fixture-page"]));
    }

    #[tokio::test]
    async fn publish_doc_submits_the_exact_signed_event_on_the_real_http_client() {
        let captured = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let state = captured.clone();
        let app = Router::new()
            .route(
                "/events",
                post(
                    |State(captured): State<std::sync::Arc<std::sync::Mutex<Vec<u8>>>>,
                     body: axum::body::Bytes| async move {
                        let event: nostr::Event =
                            serde_json::from_slice(&body).expect("signed event body");
                        *captured.lock().expect("capture") = body.to_vec();
                        Response::builder()
                            .status(StatusCode::OK)
                            .header("content-type", "application/json")
                            .body(Body::from(
                                serde_json::json!({
                                    "event_id": event.id.to_hex(),
                                    "accepted": true,
                                    "message": ""
                                })
                                .to_string(),
                            ))
                            .expect("response")
                    },
                ),
            )
            .with_state(state);
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let address = listener.local_addr().expect("address");
        tokio::spawn(async move {
            axum::serve(listener, app).await.expect("serve");
        });
        let client = client(format!("http://{address}"));
        let unsigned = write_json(&serde_json::json!({
            "kind": COMMUNITY_DOC_KIND,
            "content": "{\"title\":\"fixture\",\"body\":\"body\",\"parentId\":null,\"order\":0,\"createdAt\":1,\"updatedAt\":1}",
            "tags": [["d", "doc:fixture-page"], ["t", COMMUNITY_DOC_TAG]],
            "createdAt": 1,
        }));
        let event = sign_doc(unsigned.path().to_str().expect("path"), &client).expect("sign");
        let signed = write_json(&serde_json::to_value(&event).expect("event JSON"));

        let response = publish_doc(signed.path().to_str().expect("path"), &client)
            .await
            .expect("publish");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&response).unwrap()["event_id"],
            event.id.to_hex()
        );
        let submitted: nostr::Event =
            serde_json::from_slice(&captured.lock().expect("capture")).expect("submitted event");
        assert_eq!(submitted, event);
    }
}
