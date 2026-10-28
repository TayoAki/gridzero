//! Workbook host: WebSocket sheet channel, routing-token auth, workbook actors.
//!
//! Env: PORT (8790), DATA_DIR (./data), WB_TOKEN_SECRET (required, shared with the
//! control plane), IDLE_EVICT_SECS (900), SNAPSHOT_EVERY (500).

mod actor;

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use actor::{Cmd, Config, Registry, Role};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
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

fn env_or<T: std::str::FromStr>(name: &str, default: T) -> T {
    std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();

    let secret = std::env::var("WB_TOKEN_SECRET").map_err(|_| anyhow::anyhow!("WB_TOKEN_SECRET is required"))?;
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
    };

    let app = Router::new()
        .route("/health", get(health))
        .route("/wb/{id}/ws", get(ws_upgrade))
        .with_state(state);

    let port: u16 = env_or("PORT", 8790);
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await?;
    tracing::info!(port, data_dir, "wbhost listening");
    axum::serve(listener, app).with_graceful_shutdown(shutdown_signal()).await?;
    Ok(())
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}

async fn health(State(state): State<AppState>) -> String {
    format!("ok {} workbooks", state.registry.len())
}

async fn ws_upgrade(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<WsQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    let mut validation = Validation::new(Algorithm::HS256);
    validation.set_required_spec_claims(&["exp"]);
    let claims = match decode::<Claims>(&q.token, &state.key, &validation) {
        Ok(data) => data.claims,
        Err(e) => return (StatusCode::UNAUTHORIZED, format!("invalid token: {e}")).into_response(),
    };
    if claims.wb != id {
        return (StatusCode::FORBIDDEN, "token is for another workbook").into_response();
    }
    let Some(role) = Role::parse(&claims.role) else {
        return (StatusCode::FORBIDDEN, "unknown role").into_response();
    };
    tracing::debug!(workbook = id, user = claims.sub, ?role, "session opening");
    ws.on_upgrade(move |socket| session(socket, state, id, role))
}

async fn session(socket: WebSocket, state: AppState, id: String, role: Role) {
    let sid = state.next_sid.fetch_add(1, Ordering::Relaxed);
    let mailbox = state.registry.get_or_spawn(&id, &state.config);
    let (out_tx, mut out_rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
    if mailbox.send(Cmd::Join { sid, role, out: out_tx }).is_err() {
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
