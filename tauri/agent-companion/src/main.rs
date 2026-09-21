/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.
*/

//! Headless connector for Radxa/ARM64 Linux.
//!
//! The browser and model remain on lain42.top. This process only maintains an
//! authenticated outbound WebSocket and executes the typed, read-only
//! operations shared with the Tauri desktop runtime. It never accepts a shell
//! command or an inbound listener.

use std::{env, fs, path::PathBuf, thread, time::Duration};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tungstenite::{connect, Message};
use url::Url;

#[path = "../../src/tool_runtime.rs"]
mod tool_runtime;

use tool_runtime::{execute_operation, CancellationToken, OperationRequest, ProfileCredentials};

const DEFAULT_BRIDGE_URL: &str = "wss://api.lain42.top/api/agent/bridge/desktop";
const MAX_MESSAGE_BYTES: usize = 128 * 1024;

#[derive(Debug, Serialize, Deserialize)]
struct BridgeEnvelope {
    #[serde(rename = "type")]
    message_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    request_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    device_id: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    credential: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    operation: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    params: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn env_required(name: &str) -> Result<String, String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("{name} is required"))
}

fn device_id() -> Result<i64, String> {
    env_required("LAIN42_AGENT_DEVICE_ID")?
        .parse::<i64>()
        .map_err(|_| "LAIN42_AGENT_DEVICE_ID must be a positive integer".to_string())
        .and_then(|value| {
            (value > 0)
                .then_some(value)
                .ok_or_else(|| "LAIN42_AGENT_DEVICE_ID must be positive".to_string())
        })
}

fn profile_credentials() -> Result<ProfileCredentials, String> {
    let profile_id = env::var("LAIN42_AGENT_PROFILE")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "radxa".to_string());
    let config_dir = env::var("LAIN42_GH_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|_| {
            env::var("HOME")
                .map(|home| PathBuf::from(home).join(".config").join("gh"))
                .map_err(|error| error.to_string())
        })
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&config_dir)
        .map_err(|error| format!("Unable to create GitHub profile directory: {error}"))?;
    Ok(ProfileCredentials::new(profile_id, config_dir))
}

type BridgeSocket =
    tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<std::net::TcpStream>>;

fn send(socket: &mut BridgeSocket, envelope: BridgeEnvelope) -> Result<(), String> {
    let text = serde_json::to_string(&envelope).map_err(|error| error.to_string())?;
    if text.len() > MAX_MESSAGE_BYTES {
        return Err("Agent bridge message exceeds the size limit".to_string());
    }
    socket
        .send(Message::Text(text.into()))
        .map_err(|error| format!("Unable to send bridge message: {error}"))
}

fn run_connection(
    bridge_url: &Url,
    credential: &str,
    device_id: i64,
    credentials: &ProfileCredentials,
) -> Result<(), String> {
    let (mut socket, _) = connect(bridge_url.as_str())
        .map_err(|error| format!("Unable to connect to Lain42 Agent: {error}"))?;
    send(
        &mut socket,
        BridgeEnvelope {
            message_type: "hello".to_string(),
            request_id: None,
            device_id: Some(device_id),
            credential: Some(credential.to_string()),
            operation: None,
            params: None,
            result: None,
            error: None,
        },
    )?;

    loop {
        let message = socket
            .read()
            .map_err(|error| format!("Agent bridge disconnected: {error}"))?;
        let Message::Text(text) = message else {
            continue;
        };
        if text.len() > MAX_MESSAGE_BYTES {
            return Err("Agent bridge message exceeds the size limit".to_string());
        }
        let envelope: BridgeEnvelope = serde_json::from_str(&text)
            .map_err(|_| "Agent bridge returned invalid JSON".to_string())?;
        match envelope.message_type.as_str() {
            "hello_ack" => {}
            "ping" => send(
                &mut socket,
                BridgeEnvelope {
                    message_type: "pong".to_string(),
                    request_id: None,
                    device_id: Some(device_id),
                    credential: None,
                    operation: None,
                    params: None,
                    result: None,
                    error: None,
                },
            )?,
            "tool_request" => {
                let request_id = envelope
                    .request_id
                    .ok_or_else(|| "Tool request has no request id".to_string())?;
                let operation = envelope
                    .operation
                    .ok_or_else(|| "Tool request has no operation".to_string())?;
                let request = OperationRequest {
                    operation,
                    params: envelope.params.unwrap_or(Value::Object(Default::default())),
                    timeout_ms: Some(30_000),
                };
                match execute_operation(&request, Some(credentials), &CancellationToken::new()) {
                    Ok(result) => send(
                        &mut socket,
                        BridgeEnvelope {
                            message_type: "tool_result".to_string(),
                            request_id: Some(request_id),
                            device_id: Some(device_id),
                            credential: None,
                            operation: None,
                            params: None,
                            result: Some(serde_json::to_value(result).map_err(|e| e.to_string())?),
                            error: None,
                        },
                    )?,
                    Err(error) => send(
                        &mut socket,
                        BridgeEnvelope {
                            message_type: "tool_error".to_string(),
                            request_id: Some(request_id),
                            device_id: Some(device_id),
                            credential: None,
                            operation: None,
                            params: None,
                            result: None,
                            error: Some(error),
                        },
                    )?,
                }
            }
            _ => return Err("Unsupported agent bridge message".to_string()),
        }
    }
}

fn main() -> Result<(), String> {
    let credential = env_required("LAIN42_AGENT_CREDENTIAL")?;
    let device_id = device_id()?;
    let credentials = profile_credentials()?;
    let bridge_url =
        env::var("LAIN42_AGENT_BRIDGE_URL").unwrap_or_else(|_| DEFAULT_BRIDGE_URL.to_string());
    let bridge_url =
        Url::parse(&bridge_url).map_err(|error| format!("Invalid bridge URL: {error}"))?;
    if bridge_url.scheme() != "wss" {
        return Err("The headless companion requires a wss:// bridge URL".to_string());
    }

    let mut delay = Duration::from_secs(2);
    loop {
        match run_connection(&bridge_url, &credential, device_id, &credentials) {
            Ok(()) => delay = Duration::from_secs(2),
            Err(error) => {
                eprintln!("{error}; retrying in {}s", delay.as_secs());
                thread::sleep(delay);
                delay = (delay * 2).min(Duration::from_secs(60));
            }
        }
    }
}
