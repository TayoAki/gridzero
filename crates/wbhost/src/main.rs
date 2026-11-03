//! Workbook host: WebSocket sheet channel, routing-token auth, workbook actors.
//!
//! Env: PORT (8790), DATA_DIR (./data), WB_TOKEN_SECRET (required, shared with the
//! control plane), IDLE_EVICT_SECS (900), SNAPSHOT_EVERY (500),
//! IMPORT_ALLOW_PRIVATE_URLS (unset; tests only: lets URL import reach localhost).
//!
//! Routes: GET /health, GET /wb/{id}/ws (sheet channel), POST /wb/{id}/import
//! (file upload), POST /wb/{id}/import_url (server-side download) and
//! GET /wb/{id}/chart/{chart} (chart data as JSON), all authorised by a routing
//! token in `?token=`.

mod actor;
mod upload;

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use actor::{Cmd, Config, Registry, Role};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use jsonwebtoken::{decode, Algorithm, DecodingKey, Validation};
use protocol::ClientMsg;
use serde::Deserialize;
use storage::DirStore;

#[derive(Clone)]
struct AppState {
    registry: Registry,
    config: Arc<Config>,
    key: Arc<DecodingKey>,
    next_sid: Arc<AtomicU64>,
    allow_private_urls: bool,
}

/// Routing token issued by the control plane (BUILD-SPEC §9).
#[derive(Deserialize)]
struct Claims {
    wb: String,
    sub: String,
    role: String,
}

#[derive(Deserialize)]
struct WsQuery {
    token: String,
}

#[derive(Deserialize)]
struct ImportQuery {
    token: String,
    import_id: String,
    name: Option<String>,
    url: Option<String>,
}

fn env_or<T: std::str::FromStr>(name: &str, default: T) -> T {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    let secret = std::env::var("WB_TOKEN_SECRET")
        .map_err(|_| anyhow::anyhow!("WB_TOKEN_SECRET is required"))?;
    let data_dir: String = env_or("DATA_DIR", "./data".to_string());
    let config = Arc::new(Config {
        store: Arc::new(DirStore::new(&data_dir)?),
        idle_evict: Duration::from_secs(env_or("IDLE_EVICT_SECS", 900)),
        snapshot_every: env_or("SNAPSHOT_EVERY", 500),
    });
    let state = AppState {
        registry: Registry::default(),
        config,
        key: Arc::new(DecodingKey::from_secret(secret.as_bytes())),
        next_sid: Arc::new(AtomicU64::new(1)),
        allow_private_urls: std::env::var("IMPORT_ALLOW_PRIVATE_URLS").is_ok_and(|v| v == "1"),
    };

    // Uploads come straight from the browser on the app's origin; the routing token in
    // the query string is the credential, so any origin may call (no cookies are used).
    let cors = tower_http::cors::CorsLayer::new()
        .allow_origin(tower_http::cors::Any)
        .allow_methods([
            axum::http::Method::GET,
            axum::http::Method::POST,
            axum::http::Method::OPTIONS,
        ])
        .expose_headers([axum::http::header::ETAG])
        .allow_headers(tower_http::cors::Any)
        .max_age(Duration::from_secs(3600));
    let imports = Router::new()
        .route("/wb/{id}/import", post(import_upload))
        .route("/wb/{id}/import_url", post(import_url))
        .route("/wb/{id}/chart/{chart}", get(chart_data))
        .layer(DefaultBodyLimit::disable())
        .layer(cors);
    let app = Router::new()
        .route("/health", get(health))
        .route("/wb/{id}/ws", get(ws_upgrade))
        .merge(imports)
        .with_state(state);

    let port: u16 = env_or("PORT", 8790);
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await?;
    tracing::info!(port, data_dir, "wbhost listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}

async fn health(State(state): State<AppState>) -> String {
    format!("ok {} workbooks", state.registry.len())
}

/// Check a routing token for workbook `id`; returns the user and role.
fn authorize(state: &AppState, id: &str, token: &str) -> Result<(String, Role), Response> {
    let mut validation = Validation::new(Algorithm::HS256);
    validation.set_required_spec_claims(&["exp"]);
    let claims = match decode::<Claims>(token, &state.key, &validation) {
        Ok(data) => data.claims,
        Err(e) => {
            return Err((StatusCode::UNAUTHORIZED, format!("invalid token: {e}")).into_response())
        }
    };
    if claims.wb != id {
        return Err((StatusCode::FORBIDDEN, "token is for another workbook").into_response());
    }
    let Some(role) = Role::parse(&claims.role) else {
        return Err((StatusCode::FORBIDDEN, "unknown role").into_response());
    };
    Ok((claims.sub, role))
}

async fn ws_upgrade(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<WsQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    let (user, role) = match authorize(&state, &id, &q.token) {
        Ok(a) => a,
        Err(r) => return r,
    };
    tracing::debug!(workbook = id, user, ?role, "session opening");
    ws.on_upgrade(move |socket| session(socket, state, id, role))
}

fn upload_response(
    id: &str,
    import_id: &str,
    result: Result<(String, u64), upload::UploadError>,
) -> Response {
    match result {
        Ok((name, bytes)) => {
            tracing::info!(workbook = id, import_id, name, bytes, "upload staged");
            Json(serde_json::json!({ "import_id": import_id, "name": name, "bytes": bytes }))
                .into_response()
        }
        Err(upload::UploadError::Bad(m)) => (StatusCode::BAD_REQUEST, m).into_response(),
        Err(upload::UploadError::TooLarge) => {
            (StatusCode::PAYLOAD_TOO_LARGE, "files are limited to 5 GB").into_response()
        }
        Err(upload::UploadError::Io(e)) => {
            tracing::error!(workbook = id, error = %e, "upload failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "the upload could not be saved",
            )
                .into_response()
        }
    }
}

/// `POST /wb/{id}/import?token&import_id&name` with the file (or its gzip) as the body.
async fn import_upload(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<ImportQuery>,
    headers: HeaderMap,
    body: axum::body::Body,
) -> Response {
    let role = match authorize(&state, &id, &q.token) {
        Ok((_, role)) => role,
        Err(r) => return r,
    };
    if role == Role::Viewer {
        return (StatusCode::FORBIDDEN, "viewers cannot import").into_response();
    }
    let Some(name) = q.name.as_deref() else {
        return (StatusCode::BAD_REQUEST, "name is required").into_response();
    };
    let dir = match state.config.store.workbook_dir(&id) {
        Ok(d) => d,
        Err(_) => return (StatusCode::BAD_REQUEST, "invalid workbook id").into_response(),
    };
    let gzip = headers
        .get("content-encoding")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.contains("gzip"));
    let result = upload::stage(dir, &q.import_id, name, gzip, body.into_data_stream()).await;
    upload_response(&id, &q.import_id, result)
}

/// `POST /wb/{id}/import_url?token&import_id&url`: the host downloads the file itself.
async fn import_url(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<ImportQuery>,
) -> Response {
    let role = match authorize(&state, &id, &q.token) {
        Ok((_, role)) => role,
        Err(r) => return r,
    };
    if role == Role::Viewer {
        return (StatusCode::FORBIDDEN, "viewers cannot import").into_response();
    }
    let Some(url) = q.url.as_deref() else {
        return (StatusCode::BAD_REQUEST, "url is required").into_response();
    };
    let dir = match state.config.store.workbook_dir(&id) {
        Ok(d) => d,
        Err(_) => return (StatusCode::BAD_REQUEST, "invalid workbook id").into_response(),
    };
    let result = upload::fetch(dir, &q.import_id, url, state.allow_private_urls).await;
    upload_response(&id, &q.import_id, result)
}

/// `GET /wb/{id}/chart/{chart}?token`: a chart's evaluated series as JSON. The ETag is
/// the workbook's seq, so an unchanged workbook answers 304 to `If-None-Match`.
async fn chart_data(
    State(state): State<AppState>,
    Path((id, chart)): Path<(String, String)>,
    Query(q): Query<WsQuery>,
    headers: HeaderMap,
) -> Response {
    if let Err(r) = authorize(&state, &id, &q.token) {
        return r;
    }
    if state.config.store.workbook_dir(&id).is_err() {
        return (StatusCode::BAD_REQUEST, "invalid workbook id").into_response();
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mailbox = state.registry.get_or_spawn(&id, &state.config);
    let cmd = Cmd::Query {
        action: protocol::Action::GetChart { id: chart.clone() },
        reply: tx,
    };
    if mailbox.send(cmd).is_err() {
        return (StatusCode::SERVICE_UNAVAILABLE, "workbook is restarting").into_response();
    }
    match rx.await {
        Ok(Ok((seq, protocol::Reply::Chart { data }))) => {
            let etag = format!("\"{seq}-{chart}\"");
            let headers_out = [
                (axum::http::header::ETAG, etag.clone()),
                (
                    axum::http::header::CACHE_CONTROL,
                    "private, no-cache".to_string(),
                ),
            ];
            let fresh = headers
                .get(axum::http::header::IF_NONE_MATCH)
                .and_then(|v| v.to_str().ok())
                .is_some_and(|v| v == etag);
            if fresh {
                (StatusCode::NOT_MODIFIED, headers_out).into_response()
            } else {
                (headers_out, Json(data)).into_response()
            }
        }
        Ok(Ok(_)) => (StatusCode::INTERNAL_SERVER_ERROR, "unexpected reply").into_response(),
        Ok(Err(m)) => (StatusCode::NOT_FOUND, m).into_response(),
        Err(_) => (StatusCode::SERVICE_UNAVAILABLE, "workbook is restarting").into_response(),
    }
}

async fn session(socket: WebSocket, state: AppState, id: String, role: Role) {
    let sid = state.next_sid.fetch_add(1, Ordering::Relaxed);
    let mailbox = state.registry.get_or_spawn(&id, &state.config);
    let (out_tx, mut out_rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
    if mailbox
        .send(Cmd::Join {
            sid,
            role,
            out: out_tx,
        })
        .is_err()
    {
        return;
    }

    let (mut sink, mut stream) = socket.split();
    let writer = tokio::spawn(async move {
        while let Some(bytes) = out_rx.recv().await {
            if sink.send(Message::Binary(bytes.into())).await.is_err() {
                break;
            }
        }
    });

    while let Some(Ok(frame)) = stream.next().await {
        match frame {
            Message::Text(text) => match ClientMsg::parse(&text) {
                Ok(msg) => {
                    if mailbox.send(Cmd::Msg { sid, msg }).is_err() {
                        break;
                    }
                }
                Err(e) => tracing::warn!(workbook = id, error = %e, "unparseable client message"),
            },
            Message::Close(_) => break,
            _ => {}
        }
    }
    let _ = mailbox.send(Cmd::Leave { sid });
    writer.abort();
}
