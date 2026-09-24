/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.
*/

//! Explicit, bounded MCP client sessions for the desktop shell.
//!
//! A webview can select a local stdio executable or an HTTPS Streamable HTTP
//! endpoint, but it never supplies a shell fragment.  Connection credentials
//! live only inside rmcp's transport and are deliberately absent from response
//! types and error messages.

use std::{
    collections::{BTreeMap, BTreeSet},
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    sync::Arc,
    time::Duration,
};

use rmcp::{
    model::{
        CallToolRequestParams, ClientCapabilities, ClientConfig, Implementation,
        PaginatedRequestParams, ProtocolVersion, Tool,
    },
    service::{ClientLifecycleMode, RoleClient, RunningService},
    transport::{
        streamable_http_client::StreamableHttpClientTransportConfig, ConfigureCommandExt,
        StreamableHttpClientTransport,
    },
    ClientServiceExt,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;
use tokio::{net::lookup_host, sync::Mutex, time::timeout};

#[path = "bounded_mcp_stdio.rs"]
mod bounded_mcp_stdio;
use bounded_mcp_stdio::BoundedMcpStdioTransport;

const MAX_SERVERS: usize = 16;
const MAX_TOOLS_PER_SERVER: usize = 128;
const MAX_TOOL_NAME_BYTES: usize = 128;
const MAX_SERVER_NAME_BYTES: usize = 128;
const MAX_COMMAND_BYTES: usize = 1024;
const MAX_COMMAND_ARGS: usize = 64;
const MAX_COMMAND_ARG_BYTES: usize = 2048;
const MAX_URL_BYTES: usize = 2048;
const MAX_TOKEN_BYTES: usize = 4096;
const MAX_ARGUMENT_BYTES: usize = 32 * 1024;
const MAX_SCHEMA_BYTES: usize = 16 * 1024;
const MAX_DESCRIPTION_BYTES: usize = 1000;
const MAX_RESPONSE_BYTES: usize = 64 * 1024;
const MAX_TOTAL_TOOLS: usize = 256;
const MAX_PENDING_CONNECTIONS: usize = 4;
const MAX_CATALOG_BYTES: usize = 96 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const DEFAULT_CALL_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_CALL_TIMEOUT: Duration = Duration::from_secs(45);
const CLOSE_TIMEOUT: Duration = Duration::from_secs(3);

type McpClient = RunningService<RoleClient, ClientConfig>;

pub struct McpState {
    sessions: Mutex<BTreeMap<String, Arc<Mutex<McpSession>>>>,
    connecting: Mutex<BTreeSet<String>>,
}

impl Default for McpState {
    fn default() -> Self {
        Self {
            sessions: Mutex::new(BTreeMap::new()),
            connecting: Mutex::new(BTreeSet::new()),
        }
    }
}

async fn release_connecting(state: &McpState, server_id: &str) {
    state.connecting.lock().await.remove(server_id);
}

struct McpSession {
    client: McpClient,
    descriptor: McpServerDescriptor,
}

#[derive(Debug, Deserialize)]
pub struct McpConnectRequest {
    pub server_id: String,
    pub name: String,
    pub transport: String,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub bearer_token: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct McpCallRequest {
    pub server_id: String,
    pub tool_name: String,
    pub arguments: Value,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct McpToolDescriptor {
    pub server_id: String,
    pub server_name: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub input_schema: Value,
}

#[derive(Debug, Clone, Serialize)]
pub struct McpServerDescriptor {
    pub server_id: String,
    pub name: String,
    pub transport: String,
    pub tools: Vec<McpToolDescriptor>,
}

#[derive(Serialize)]
pub struct McpConnectResponse {
    server: McpServerDescriptor,
}

#[derive(Serialize)]
pub struct McpListResponse {
    servers: Vec<McpServerDescriptor>,
}

fn bounded_text(value: &str, maximum: usize) -> String {
    if value.len() <= maximum {
        return value.to_string();
    }
    let mut end = maximum;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_string()
}

fn valid_identifier(value: &str, maximum: usize, label: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || value.len() > maximum {
        return Err(format!("{label} must contain 1-{maximum} bytes."));
    }
    if value.chars().any(|character| character.is_control()) {
        return Err(format!("{label} contains control characters."));
    }
    Ok(value.to_string())
}

fn valid_server_id(value: &str) -> Result<String, String> {
    let value = valid_identifier(value, MAX_SERVER_NAME_BYTES, "MCP server id")?;
    if value
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        Ok(value)
    } else {
        Err("MCP server id may contain only letters, digits, hyphens, and underscores.".to_string())
    }
}

fn forbid_host(host: &str) -> bool {
    let host = host.trim_matches(['[', ']']).trim_end_matches('.');
    host.is_empty()
        || host.eq_ignore_ascii_case("localhost")
        || host.to_ascii_lowercase().ends_with(".localhost")
        || host.parse::<IpAddr>().is_ok_and(forbidden_ip)
}

fn reserve_connection(
    session_count: usize,
    pending_count: usize,
    already_connected: bool,
) -> Result<(), String> {
    if pending_count >= MAX_PENDING_CONNECTIONS {
        return Err("Too many MCP connections are already in progress.".to_string());
    }
    if !already_connected && session_count.saturating_add(pending_count) >= MAX_SERVERS {
        return Err(format!(
            "At most {MAX_SERVERS} MCP servers may be connected."
        ));
    }
    Ok(())
}

fn validate_stdio(request: &McpConnectRequest) -> Result<(String, Vec<String>), String> {
    let command = request
        .command
        .as_deref()
        .ok_or_else(|| "A stdio MCP command is required.".to_string())?
        .trim();
    if command.is_empty() || command.len() > MAX_COMMAND_BYTES || command.contains('\0') {
        return Err("Invalid stdio MCP command.".to_string());
    }
    if request.args.len() > MAX_COMMAND_ARGS {
        return Err(format!(
            "MCP command accepts at most {MAX_COMMAND_ARGS} arguments."
        ));
    }
    if request
        .args
        .iter()
        .any(|argument| argument.len() > MAX_COMMAND_ARG_BYTES || argument.contains('\0'))
    {
        return Err(format!(
            "Each MCP command argument must be at most {MAX_COMMAND_ARG_BYTES} bytes and contain no NUL."
        ));
    }
    Ok((command.to_string(), request.args.clone()))
}

fn validate_http(request: &McpConnectRequest) -> Result<(String, Option<String>), String> {
    let raw_url = request
        .url
        .as_deref()
        .ok_or_else(|| "An HTTPS Streamable MCP URL is required.".to_string())?
        .trim();
    if raw_url.is_empty() || raw_url.len() > MAX_URL_BYTES {
        return Err("Invalid MCP URL length.".to_string());
    }
    let parsed = url::Url::parse(raw_url).map_err(|_| "Invalid MCP URL.".to_string())?;
    if parsed.scheme() != "https"
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.fragment().is_some()
    {
        return Err(
            "MCP endpoints must be absolute HTTPS URLs without credentials or fragments."
                .to_string(),
        );
    }
    let host = parsed.host_str().expect("host was checked above");
    if forbid_host(host) {
        return Err(
            "MCP HTTPS endpoints cannot target local or private network addresses.".to_string(),
        );
    }
    let token = request
        .bearer_token
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    if token.as_ref().is_some_and(|value| {
        value.len() > MAX_TOKEN_BYTES || value.contains('\r') || value.contains('\n')
    }) {
        return Err("Invalid MCP bearer token.".to_string());
    }
    Ok((parsed.into(), token))
}

fn forbidden_ip(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => {
            let octets = address.octets();
            address.is_private()
                || address.is_loopback()
                || address.is_link_local()
                || address.is_broadcast()
                || address.is_unspecified()
                || address.is_multicast()
                || (octets[0] == 100 && (64..=127).contains(&octets[1]))
        }
        IpAddr::V6(address) => {
            address.is_loopback()
                || address.is_unspecified()
                || address.is_unique_local()
                || address.is_unicast_link_local()
                || address.is_multicast()
                || mapped_ipv4(address).is_some_and(|mapped| forbidden_ip(IpAddr::V4(mapped)))
        }
    }
}

fn mapped_ipv4(address: Ipv6Addr) -> Option<Ipv4Addr> {
    let segments = address.segments();
    if segments[..5].iter().all(|segment| *segment == 0) && matches!(segments[5], 0 | 0xffff) {
        return Some(Ipv4Addr::new(
            (segments[6] >> 8) as u8,
            segments[6] as u8,
            (segments[7] >> 8) as u8,
            segments[7] as u8,
        ));
    }
    None
}

async fn resolve_public_endpoint(raw_url: &str) -> Result<(String, SocketAddr), String> {
    let parsed = url::Url::parse(raw_url).map_err(|_| "Invalid MCP URL.".to_string())?;
    let host = parsed
        .host_str()
        .ok_or_else(|| "MCP URL has no host.".to_string())?
        .trim_matches(['[', ']'])
        .to_string();
    let port = parsed
        .port_or_known_default()
        .ok_or_else(|| "MCP URL has no known HTTPS port.".to_string())?;
    let mut addresses = lookup_host((host.as_str(), port))
        .await
        .map_err(|_| "Unable to resolve the MCP HTTPS host.".to_string())?;
    let mut selected = None;
    while let Some(address) = addresses.next() {
        if forbidden_ip(address.ip()) {
            return Err(
                "MCP HTTPS endpoints cannot resolve to local or private network addresses."
                    .to_string(),
            );
        }
        selected.get_or_insert(address);
    }
    drop(addresses);
    selected
        .map(|address| (host, address))
        .ok_or_else(|| "MCP HTTPS host resolved to no addresses.".to_string())
}

fn client_config() -> ClientConfig {
    ClientConfig::new(
        ClientCapabilities::default(),
        Implementation::new("lain42-agent-desktop", env!("CARGO_PKG_VERSION")),
    )
}

fn lifecycle() -> ClientLifecycleMode {
    ClientLifecycleMode::Auto {
        preferred_versions: vec![ProtocolVersion::V_2026_07_28],
        legacy_version: Some(ProtocolVersion::V_2025_11_25),
    }
}

async fn connect_client(request: &McpConnectRequest) -> Result<McpClient, String> {
    match request.transport.as_str() {
        "stdio" => {
            let (command, args) = validate_stdio(request)?;
            let transport = BoundedMcpStdioTransport::spawn(
                tokio::process::Command::new(command).configure(|process| {
                    process.args(args);
                }),
                MAX_RESPONSE_BYTES,
            )
            .map_err(|_| "Unable to start the selected MCP command.".to_string())?;
            timeout(
                CONNECT_TIMEOUT,
                client_config().serve_with_lifecycle(transport, lifecycle()),
            )
            .await
            .map_err(|_| "MCP connection timed out.".to_string())?
            .map_err(|_| "MCP initialization failed.".to_string())
        }
        "streamable_http" => {
            let (url, token) = validate_http(request)?;
            let (host, address) = resolve_public_endpoint(&url).await?;
            let http_client = reqwest::Client::builder()
                .no_proxy()
                .resolve(&host, address)
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|_| "Unable to create the MCP HTTPS client.".to_string())?;
            let mut transport_config = StreamableHttpClientTransportConfig::with_uri(url)
                .max_concurrent_requests(1)
                .control_request_timeout(CONNECT_TIMEOUT)
                .session_recovery_timeout(CONNECT_TIMEOUT)
                .max_sse_event_size(MAX_RESPONSE_BYTES)
                .reinit_on_expired_session(false);
            if let Some(token) = token {
                transport_config = transport_config.auth_header(token);
            }
            let transport =
                StreamableHttpClientTransport::with_client(http_client, transport_config);
            timeout(
                CONNECT_TIMEOUT,
                client_config().serve_with_lifecycle(transport, lifecycle()),
            )
            .await
            .map_err(|_| "MCP connection timed out.".to_string())?
            .map_err(|_| "MCP initialization failed.".to_string())
        }
        _ => Err("MCP transport must be stdio or streamable_http.".to_string()),
    }
}

fn tool_descriptor(server_id: &str, server_name: &str, tool: Tool) -> Option<McpToolDescriptor> {
    let name = tool.name.as_ref();
    if name.is_empty() || name.len() > MAX_TOOL_NAME_BYTES || name.chars().any(char::is_control) {
        return None;
    }
    let schema = Value::Object(tool.input_schema.as_ref().clone());
    let input_schema = match serde_json::to_vec(&schema) {
        Ok(bytes) if bytes.len() <= MAX_SCHEMA_BYTES => schema,
        _ => json!({"type":"object", "additionalProperties":true}),
    };
    Some(McpToolDescriptor {
        server_id: server_id.to_string(),
        server_name: server_name.to_string(),
        name: name.to_string(),
        description: tool
            .description
            .as_deref()
            .filter(|value| !value.is_empty())
            .map(|value| bounded_text(value, MAX_DESCRIPTION_BYTES)),
        input_schema,
    })
}

fn ensure_catalog_bounds(servers: &[McpServerDescriptor]) -> Result<(), String> {
    let tool_count = servers
        .iter()
        .map(|server| server.tools.len())
        .sum::<usize>();
    if tool_count > MAX_TOTAL_TOOLS {
        return Err(format!(
            "MCP tool catalog exceeds the {MAX_TOTAL_TOOLS}-tool limit."
        ));
    }
    let bytes = serde_json::to_vec(servers)
        .map_err(|_| "Unable to measure the MCP tool catalog.".to_string())?;
    if bytes.len() > MAX_CATALOG_BYTES {
        return Err(format!(
            "MCP tool catalog exceeds the {MAX_CATALOG_BYTES}-byte limit."
        ));
    }
    Ok(())
}

fn append_catalog_descriptor(
    servers: &mut Vec<McpServerDescriptor>,
    descriptor: McpServerDescriptor,
) -> Result<(), String> {
    servers.push(descriptor);
    if let Err(error) = ensure_catalog_bounds(servers) {
        servers.pop();
        return Err(error);
    }
    Ok(())
}

async fn list_bounded_tools(
    client: &McpClient,
    server_id: &str,
    server_name: &str,
) -> Result<Vec<McpToolDescriptor>, String> {
    let mut cursor = None;
    let mut tools = Vec::new();
    for _ in 0..MAX_TOOLS_PER_SERVER {
        let page = client
            .list_tools(Some(PaginatedRequestParams::default().with_cursor(cursor)))
            .await
            .map_err(|_| "MCP tools/list failed.".to_string())?;
        tools.extend(
            page.tools
                .into_iter()
                .filter_map(|tool| tool_descriptor(server_id, server_name, tool))
                .take(MAX_TOOLS_PER_SERVER.saturating_sub(tools.len())),
        );
        if tools.len() >= MAX_TOOLS_PER_SERVER || page.next_cursor.is_none() {
            break;
        }
        cursor = page.next_cursor;
    }
    Ok(tools)
}

#[tauri::command]
pub async fn mcp_connect(
    state: State<'_, McpState>,
    request: McpConnectRequest,
) -> Result<McpConnectResponse, String> {
    let server_id = valid_server_id(&request.server_id)?;
    let name = valid_identifier(&request.name, MAX_SERVER_NAME_BYTES, "MCP server name")?;
    if !matches!(request.transport.as_str(), "stdio" | "streamable_http") {
        return Err("MCP transport must be stdio or streamable_http.".to_string());
    }
    {
        let sessions = state.sessions.lock().await;
        let mut connecting = state.connecting.lock().await;
        if connecting.contains(&server_id) {
            return Err("MCP server is already connecting.".to_string());
        }
        reserve_connection(
            sessions.len(),
            connecting.len(),
            sessions.contains_key(&server_id),
        )?;
        connecting.insert(server_id.clone());
    }
    let mut client = match connect_client(&request).await {
        Ok(client) => client,
        Err(error) => {
            release_connecting(&state, &server_id).await;
            return Err(error);
        }
    };
    let tools = match timeout(
        CONNECT_TIMEOUT,
        list_bounded_tools(&client, &server_id, &name),
    )
    .await
    {
        Ok(Ok(tools)) => tools,
        Ok(Err(error)) => {
            let _ = client.close_with_timeout(CLOSE_TIMEOUT).await;
            release_connecting(&state, &server_id).await;
            return Err(error);
        }
        Err(_) => {
            let _ = client.close_with_timeout(CLOSE_TIMEOUT).await;
            release_connecting(&state, &server_id).await;
            return Err("MCP tools/list timed out.".to_string());
        }
    };
    let descriptor = McpServerDescriptor {
        server_id: server_id.clone(),
        name,
        transport: request.transport,
        tools,
    };
    if let Err(error) = ensure_catalog_bounds(std::slice::from_ref(&descriptor)) {
        let _ = client.close_with_timeout(CLOSE_TIMEOUT).await;
        release_connecting(&state, &server_id).await;
        return Err(error);
    }
    let previous = {
        let mut sessions = state.sessions.lock().await;
        let mut connecting = state.connecting.lock().await;
        connecting.remove(&server_id);
        sessions.insert(
            server_id,
            Arc::new(Mutex::new(McpSession {
                client,
                descriptor: descriptor.clone(),
            })),
        )
    };
    if let Some(previous) = previous {
        let mut previous = previous.lock().await;
        let _ = previous.client.close_with_timeout(CLOSE_TIMEOUT).await;
    }
    Ok(McpConnectResponse { server: descriptor })
}

#[tauri::command]
pub async fn mcp_list(state: State<'_, McpState>) -> Result<McpListResponse, String> {
    let sessions = {
        let sessions = state.sessions.lock().await;
        sessions.values().cloned().collect::<Vec<_>>()
    };
    let mut descriptors = Vec::new();
    for session in sessions {
        let mut session = session.lock().await;
        let server_id = session.descriptor.server_id.clone();
        let server_name = session.descriptor.name.clone();
        let tools = timeout(
            CONNECT_TIMEOUT,
            list_bounded_tools(&session.client, &server_id, &server_name),
        )
        .await
        .map_err(|_| format!("MCP tools/list timed out for {server_id}."))??;
        session.descriptor.tools = tools;
        append_catalog_descriptor(&mut descriptors, session.descriptor.clone())?;
    }
    ensure_catalog_bounds(&descriptors)?;
    Ok(McpListResponse {
        servers: descriptors,
    })
}

#[tauri::command]
pub async fn mcp_call(
    state: State<'_, McpState>,
    request: McpCallRequest,
) -> Result<Value, String> {
    let server_id = valid_server_id(&request.server_id)?;
    let tool_name = valid_identifier(&request.tool_name, MAX_TOOL_NAME_BYTES, "MCP tool name")?;
    let arguments = request
        .arguments
        .as_object()
        .cloned()
        .ok_or_else(|| "MCP tool arguments must be a JSON object.".to_string())?;
    if serde_json::to_vec(&arguments)
        .map_err(|_| "Unable to serialize MCP tool arguments.".to_string())?
        .len()
        > MAX_ARGUMENT_BYTES
    {
        return Err(format!(
            "MCP tool arguments exceed {MAX_ARGUMENT_BYTES} bytes."
        ));
    }
    let call_timeout = Duration::from_millis(
        request
            .timeout_ms
            .unwrap_or(DEFAULT_CALL_TIMEOUT.as_millis() as u64)
            .clamp(1, MAX_CALL_TIMEOUT.as_millis() as u64),
    );
    let session = state
        .sessions
        .lock()
        .await
        .get(&server_id)
        .cloned()
        .ok_or_else(|| "MCP server is not connected.".to_string())?;
    let session = session.lock().await;
    if !session
        .descriptor
        .tools
        .iter()
        .any(|tool| tool.name == tool_name)
    {
        return Err("MCP tool is not available from this server.".to_string());
    }
    let result = timeout(
        call_timeout,
        session
            .client
            .call_tool(CallToolRequestParams::new(tool_name).with_arguments(arguments)),
    )
    .await;
    let result = match result {
        Ok(result) => result.map_err(|_| "MCP tools/call failed.".to_string())?,
        Err(_) => {
            session.client.cancellation_token().cancel();
            drop(session);
            state.sessions.lock().await.remove(&server_id);
            return Err("MCP tools/call timed out; the session was disconnected.".to_string());
        }
    };
    let value = serde_json::to_value(result)
        .map_err(|_| "Unable to encode MCP tool result.".to_string())?;
    if serde_json::to_vec(&value)
        .map_err(|_| "Unable to measure MCP tool result.".to_string())?
        .len()
        > MAX_RESPONSE_BYTES
    {
        return Err(format!(
            "MCP tool result exceeds {MAX_RESPONSE_BYTES} bytes."
        ));
    }
    Ok(value)
}

#[tauri::command]
pub async fn mcp_disconnect(state: State<'_, McpState>, server_id: String) -> Result<(), String> {
    let server_id = valid_server_id(&server_id)?;
    let session = state
        .sessions
        .lock()
        .await
        .remove(&server_id)
        .ok_or_else(|| "MCP server is not connected.".to_string())?;
    let mut session = session.lock().await;
    session
        .client
        .close_with_timeout(CLOSE_TIMEOUT)
        .await
        .map_err(|_| "MCP session shutdown failed.".to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn official_everything_entry() -> String {
        std::env::var("LAIN42_MCP_EVERYTHING_ENTRY")
            .expect("Actions must install the pinned official MCP Everything server fixture")
    }

    async fn exercise_official_echo(client: McpClient) -> Result<(), String> {
        let tools =
            list_bounded_tools(&client, "official-everything", "Official Everything").await?;
        if !tools.iter().any(|tool| tool.name == "echo") {
            return Err("Official MCP server did not expose the echo tool.".to_string());
        }

        let arguments = serde_json::from_value(json!({"message": "lain42 MCP interoperability"}))
            .map_err(|_| "Unable to prepare the MCP echo request.".to_string())?;
        let result = client
            .call_tool(CallToolRequestParams::new("echo").with_arguments(arguments))
            .await
            .map_err(|_| "Official MCP tools/call failed.".to_string())?;
        let value = serde_json::to_value(result)
            .map_err(|_| "Unable to encode the MCP echo response.".to_string())?;
        let echoed = value
            .get("content")
            .and_then(Value::as_array)
            .and_then(|content| content.first())
            .and_then(|item| item.get("text"))
            .and_then(Value::as_str);
        if echoed != Some("Echo: lain42 MCP interoperability") {
            return Err(
                "Official MCP echo response did not reach the client unchanged.".to_string(),
            );
        }

        client
            .close_with_timeout(CLOSE_TIMEOUT)
            .await
            .map_err(|_| "Official MCP session did not close cleanly.".to_string())
            .map(|_| ())
    }

    #[tokio::test]
    #[ignore = "Run in GitHub Actions with the official MCP server fixture installed"]
    async fn official_everything_stdio_interoperability() {
        let request = McpConnectRequest {
            server_id: "official-everything".to_string(),
            name: "Official Everything".to_string(),
            transport: "stdio".to_string(),
            command: Some("node".to_string()),
            args: vec![official_everything_entry(), "stdio".to_string()],
            url: None,
            bearer_token: None,
        };
        let client = connect_client(&request)
            .await
            .expect("official MCP stdio server should initialize");
        exercise_official_echo(client)
            .await
            .expect("official MCP stdio list/call/close should interoperate");
    }

    #[tokio::test]
    #[ignore = "Run in GitHub Actions with the official MCP server fixture installed"]
    async fn official_everything_streamable_http_interoperability() {
        use std::{net::TcpListener, process::Stdio, time::Instant};
        use tokio::{net::TcpStream, process::Command, time::sleep};

        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .expect("reserve an ephemeral local port for the test server");
        let port = listener.local_addr().unwrap().port();
        drop(listener);

        let mut server = Command::new("node")
            .arg(official_everything_entry())
            .arg("streamableHttp")
            .env("PORT", port.to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .expect("start official MCP Streamable HTTP server");

        let startup_deadline = Instant::now() + Duration::from_secs(15);
        let mut ready = false;
        while Instant::now() < startup_deadline {
            if TcpStream::connect((Ipv4Addr::LOCALHOST, port))
                .await
                .is_ok()
            {
                ready = true;
                break;
            }
            if matches!(server.try_wait(), Ok(Some(_))) {
                break;
            }
            sleep(Duration::from_millis(100)).await;
        }
        if !ready {
            let _ = server.kill().await;
            let _ = server.wait().await;
            panic!("official MCP Streamable HTTP server did not start");
        }

        let http_client = reqwest::Client::builder()
            .no_proxy()
            .build()
            .expect("create test-only HTTP client");
        let transport_config =
            StreamableHttpClientTransportConfig::with_uri(format!("http://127.0.0.1:{port}/mcp"))
                .max_concurrent_requests(1)
                .control_request_timeout(CONNECT_TIMEOUT)
                .session_recovery_timeout(CONNECT_TIMEOUT)
                .max_sse_event_size(MAX_RESPONSE_BYTES)
                .reinit_on_expired_session(false);
        let transport = StreamableHttpClientTransport::with_client(http_client, transport_config);
        let client = timeout(
            CONNECT_TIMEOUT,
            client_config().serve_with_lifecycle(transport, lifecycle()),
        )
        .await
        .expect("official MCP HTTP initialization should not time out")
        .expect("official MCP HTTP initialization should succeed");
        let result = exercise_official_echo(client).await;
        let _ = server.kill().await;
        let _ = server.wait().await;
        result.expect("official MCP HTTP list/call/close should interoperate");
    }

    #[test]
    fn rejects_shell_shaped_stdio_inputs() {
        let request = McpConnectRequest {
            server_id: "local".to_string(),
            name: "Local".to_string(),
            transport: "stdio".to_string(),
            command: Some("cmd\0.exe".to_string()),
            args: Vec::new(),
            url: None,
            bearer_token: None,
        };
        assert!(validate_stdio(&request).is_err());
    }

    #[test]
    fn accepts_only_safe_https_urls() {
        let mut request = McpConnectRequest {
            server_id: "remote".to_string(),
            name: "Remote".to_string(),
            transport: "streamable_http".to_string(),
            command: None,
            args: Vec::new(),
            url: Some("http://127.0.0.1/mcp".to_string()),
            bearer_token: None,
        };
        assert!(validate_http(&request).is_err());
        request.url = Some("https://example.test/mcp".to_string());
        assert!(validate_http(&request).is_ok());
        request.url = Some("https://127.0.0.1/mcp".to_string());
        assert!(validate_http(&request).is_err());
        request.url = Some("https://[::ffff:10.0.0.1]/mcp".to_string());
        assert!(validate_http(&request).is_err());
        request.url = Some("https://localhost./mcp".to_string());
        assert!(validate_http(&request).is_err());
        assert!(forbid_host("[::ffff:10.0.0.1]"));
        assert!(forbid_host("[::10.0.0.1]"));
        assert!(forbidden_ip("100.64.0.1".parse().unwrap()));
        assert!(forbidden_ip("ff02::1".parse().unwrap()));
    }

    #[tokio::test]
    async fn dns_resolution_rejects_embedded_private_ipv6() {
        assert!(resolve_public_endpoint("https://[::ffff:10.0.0.1]/mcp")
            .await
            .is_err());
        assert!(resolve_public_endpoint("https://[::10.0.0.1]/mcp")
            .await
            .is_err());
    }

    #[test]
    fn pending_connections_reserve_capacity() {
        assert!(reserve_connection(MAX_SERVERS - 1, 1, false).is_err());
        assert!(reserve_connection(MAX_SERVERS, 0, true).is_ok());
        assert!(reserve_connection(0, MAX_PENDING_CONNECTIONS, false).is_err());
    }

    #[test]
    fn response_and_schema_boundaries_are_preserved() {
        let text = format!("{}€", "a".repeat(MAX_DESCRIPTION_BYTES));
        let bounded = bounded_text(&text, MAX_DESCRIPTION_BYTES);
        assert!(bounded.len() <= MAX_DESCRIPTION_BYTES);
        assert!(bounded.is_char_boundary(bounded.len()));
        let mut tool = Tool::default();
        tool.name = "large-schema".into();
        let mut schema = serde_json::Map::new();
        schema.insert(
            "description".to_string(),
            Value::String("x".repeat(MAX_SCHEMA_BYTES)),
        );
        tool.input_schema = Arc::new(schema);
        let descriptor = tool_descriptor("remote", "Remote", tool).unwrap();
        assert_eq!(
            descriptor.input_schema,
            json!({"type":"object", "additionalProperties":true})
        );
    }

    #[test]
    fn catalog_bounds_protect_the_bridge_payload() {
        let descriptor = McpServerDescriptor {
            server_id: "remote".to_string(),
            name: "Remote".to_string(),
            transport: "stdio".to_string(),
            tools: vec![],
        };
        assert!(ensure_catalog_bounds(std::slice::from_ref(&descriptor)).is_ok());
        let oversized = vec![McpToolDescriptor {
            server_id: descriptor.server_id.clone(),
            server_name: descriptor.name.clone(),
            name: "tool".to_string(),
            description: Some("x".repeat(MAX_DESCRIPTION_BYTES)),
            input_schema: json!({"type":"object"}),
        }];
        let oversized_descriptor = McpServerDescriptor {
            tools: oversized,
            ..descriptor
        };
        assert!(ensure_catalog_bounds(&vec![oversized_descriptor; MAX_TOTAL_TOOLS + 1]).is_err());
    }

    #[test]
    fn catalog_aggregation_stops_before_exceeding_bridge_limit() {
        let tool = McpToolDescriptor {
            server_id: "remote".to_string(),
            server_name: "Remote".to_string(),
            name: "tool".to_string(),
            description: None,
            input_schema: json!({"type":"object"}),
        };
        let descriptor = McpServerDescriptor {
            server_id: "remote".to_string(),
            name: "Remote".to_string(),
            transport: "stdio".to_string(),
            tools: vec![tool],
        };
        let mut catalog = vec![descriptor.clone(); MAX_TOTAL_TOOLS];
        assert!(append_catalog_descriptor(&mut catalog, descriptor).is_err());
        assert_eq!(catalog.len(), MAX_TOTAL_TOOLS);
    }
}
