/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.
*/

//! A purely headless Radxa companion.  It has no GUI, WebView, display server,
//! browser, or inbound listener.  It keeps an outbound authenticated WSS
//! connection and executes a small, configured set of CLI and MCP operations.

use std::{
    collections::{BTreeMap, BTreeSet},
    env, fs,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    path::{Path, PathBuf},
    thread,
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
use tokio::{net::lookup_host, runtime::Runtime, time::timeout};
use tungstenite::{connect, Message};
use url::Url;

#[path = "../../src/bounded_mcp_stdio.rs"]
mod bounded_mcp_stdio;
use bounded_mcp_stdio::BoundedMcpStdioTransport;

#[path = "../../src/tool_runtime.rs"]
mod tool_runtime;
use tool_runtime::{execute_operation, CancellationToken, OperationRequest, ProfileCredentials};

const DEFAULT_BRIDGE_URL: &str = "wss://api.lain42.top/api/agent/bridge/desktop";
const AGENT_BRIDGE_PROTOCOL_VERSION: u32 = 1;
const MAX_MESSAGE_BYTES: usize = 128 * 1024;
const MAX_MCP_CONFIG_BYTES: u64 = 64 * 1024;
const MAX_MCP_SERVERS: usize = 4;
const MAX_TOOLS_PER_SERVER: usize = 64;
const MAX_TOTAL_TOOLS: usize = 128;
const MAX_CATALOG_BYTES: usize = 96 * 1024;
const MAX_SERVER_TEXT_BYTES: usize = 128;
const MAX_TOOL_NAME_BYTES: usize = 128;
const MAX_COMMAND_BYTES: usize = 1024;
const MAX_COMMAND_ARGS: usize = 64;
const MAX_COMMAND_ARG_BYTES: usize = 2048;
const MAX_URL_BYTES: usize = 2048;
const MAX_TOKEN_BYTES: usize = 4096;
const MAX_ARGUMENT_BYTES: usize = 32 * 1024;
const MAX_SCHEMA_BYTES: usize = 16 * 1024;
const MAX_DESCRIPTION_BYTES: usize = 1000;
const MAX_RESPONSE_BYTES: usize = 64 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const CLOSE_TIMEOUT: Duration = Duration::from_secs(3);

type McpClient = RunningService<RoleClient, ClientConfig>;
type BridgeSocket =
    tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<std::net::TcpStream>>;

#[derive(Debug, Serialize, Deserialize)]
struct BridgeEnvelope {
    #[serde(rename = "type")]
    message_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    protocol_version: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    capabilities: Option<Vec<String>>,
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

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct McpConfigFile {
    servers: Vec<McpServerConfig>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct McpServerConfig {
    server_id: String,
    name: String,
    transport: String,
    #[serde(default)]
    command: Option<String>,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    bearer_token_env: Option<String>,
    allowed_tools: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct McpCallRequest {
    server_id: String,
    tool_name: String,
    arguments: Value,
    #[serde(default)]
    timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
struct McpToolDescriptor {
    server_id: String,
    server_name: String,
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    input_schema: Value,
}

#[derive(Debug, Clone, Serialize)]
struct McpServerDescriptor {
    server_id: String,
    name: String,
    transport: String,
    tools: Vec<McpToolDescriptor>,
}

struct McpRuntime {
    runtime: Runtime,
    servers: BTreeMap<String, McpServerConfig>,
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
            env::var("HOME").map(|home| {
                PathBuf::from(home)
                    .join(".config")
                    .join("lain42")
                    .join("gh")
                    .join(&profile_id)
            })
        })
        .map_err(|_| "Unable to determine the GitHub profile directory.".to_string())?;
    fs::create_dir_all(&config_dir)
        .map_err(|_| "Unable to create the GitHub profile directory.".to_string())?;
    Ok(ProfileCredentials::new(profile_id, config_dir))
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
    if value.is_empty() || value.len() > maximum || value.chars().any(char::is_control) {
        return Err(format!("Invalid {label}."));
    }
    Ok(value.to_string())
}

fn valid_server_id(value: &str) -> Result<String, String> {
    let value = valid_identifier(value, MAX_SERVER_TEXT_BYTES, "MCP server id")?;
    if value
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        Ok(value)
    } else {
        Err("MCP server id may contain only letters, digits, hyphens, and underscores.".to_string())
    }
}

fn valid_env_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.chars().all(|character| {
            character.is_ascii_uppercase() || character.is_ascii_digit() || character == '_'
        })
}

fn validate_stdio(server: &McpServerConfig) -> Result<(), String> {
    let command = server
        .command
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "A stdio MCP command is required.".to_string())?;
    if command.len() > MAX_COMMAND_BYTES
        || command.contains('\0')
        || command.chars().any(char::is_control)
    {
        return Err("Invalid stdio MCP command.".to_string());
    }
    if server.args.len() > MAX_COMMAND_ARGS
        || server.args.iter().any(|argument| {
            argument.len() > MAX_COMMAND_ARG_BYTES
                || argument.contains('\0')
                || argument.chars().any(char::is_control)
        })
    {
        return Err("Invalid stdio MCP arguments.".to_string());
    }
    Ok(())
}

fn validate_http(server: &McpServerConfig) -> Result<String, String> {
    let raw_url = server
        .url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "An HTTPS Streamable MCP URL is required.".to_string())?;
    if raw_url.len() > MAX_URL_BYTES {
        return Err("Invalid MCP URL length.".to_string());
    }
    let parsed = Url::parse(raw_url).map_err(|_| "Invalid MCP URL.".to_string())?;
    let host = parsed
        .host_str()
        .unwrap_or_default()
        .trim_matches(['[', ']']);
    if parsed.scheme() != "https"
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.fragment().is_some()
        || host.is_empty()
        || host.eq_ignore_ascii_case("localhost")
        || host.to_ascii_lowercase().ends_with(".localhost")
        || host.parse::<IpAddr>().is_ok_and(forbidden_ip)
    {
        return Err("MCP HTTPS endpoints must use a public https:// URL.".to_string());
    }
    if server
        .bearer_token_env
        .as_deref()
        .is_some_and(|name| !valid_env_name(name))
    {
        return Err("Invalid MCP bearer token environment variable name.".to_string());
    }
    Ok(parsed.into())
}

fn validate_server(server: &McpServerConfig) -> Result<(), String> {
    valid_server_id(&server.server_id)?;
    valid_identifier(&server.name, MAX_SERVER_TEXT_BYTES, "MCP server name")?;
    if server.allowed_tools.is_empty() || server.allowed_tools.len() > MAX_TOOLS_PER_SERVER {
        return Err("MCP servers need 1-64 explicitly allowed tools.".to_string());
    }
    let mut tools = BTreeSet::new();
    for tool in &server.allowed_tools {
        tools.insert(valid_identifier(
            tool,
            MAX_TOOL_NAME_BYTES,
            "MCP tool name",
        )?);
    }
    if tools.len() != server.allowed_tools.len() {
        return Err("MCP allowed tool names must be unique.".to_string());
    }
    match server.transport.as_str() {
        "stdio" => {
            validate_stdio(server)?;
            if server.url.is_some() || server.bearer_token_env.is_some() {
                return Err("stdio MCP servers cannot set HTTP fields.".to_string());
            }
        }
        "streamable_http" => {
            validate_http(server)?;
            if server.command.is_some() || !server.args.is_empty() {
                return Err("HTTP MCP servers cannot set command fields.".to_string());
            }
        }
        _ => return Err("MCP transport must be stdio or streamable_http.".to_string()),
    }
    Ok(())
}

#[cfg(unix)]
fn require_private_config(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::MetadataExt;
    let metadata =
        fs::metadata(path).map_err(|_| "Unable to read MCP configuration.".to_string())?;
    if !metadata.is_file() || metadata.mode() & 0o077 != 0 {
        return Err(
            "MCP configuration must be a regular file readable only by its owner.".to_string(),
        );
    }
    Ok(())
}

#[cfg(not(unix))]
fn require_private_config(path: &Path) -> Result<(), String> {
    if fs::metadata(path)
        .map_err(|_| "Unable to read MCP configuration.".to_string())?
        .is_file()
    {
        Ok(())
    } else {
        Err("MCP configuration must be a regular file.".to_string())
    }
}

fn load_mcp_servers() -> Result<BTreeMap<String, McpServerConfig>, String> {
    let config_path = match env::var("LAIN42_MCP_CONFIG_FILE") {
        Ok(value) if !value.trim().is_empty() => PathBuf::from(value),
        _ => return Ok(BTreeMap::new()),
    };
    require_private_config(&config_path)?;
    let metadata =
        fs::metadata(&config_path).map_err(|_| "Unable to read MCP configuration.".to_string())?;
    if metadata.len() > MAX_MCP_CONFIG_BYTES {
        return Err("MCP configuration exceeds the 64 KiB limit.".to_string());
    }
    let contents = fs::read_to_string(&config_path)
        .map_err(|_| "Unable to read MCP configuration.".to_string())?;
    let config: McpConfigFile = serde_json::from_str(&contents)
        .map_err(|_| "Invalid MCP configuration JSON.".to_string())?;
    if config.servers.len() > MAX_MCP_SERVERS {
        return Err("At most four MCP servers may be configured.".to_string());
    }
    let mut servers = BTreeMap::new();
    for server in config.servers {
        validate_server(&server)?;
        let id = valid_server_id(&server.server_id)?;
        if servers.insert(id, server).is_some() {
            return Err("MCP server ids must be unique.".to_string());
        }
    }
    Ok(servers)
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
        Some(Ipv4Addr::new(
            (segments[6] >> 8) as u8,
            segments[6] as u8,
            (segments[7] >> 8) as u8,
            segments[7] as u8,
        ))
    } else {
        None
    }
}

async fn resolve_public_endpoint(raw_url: &str) -> Result<(String, SocketAddr), String> {
    let parsed = Url::parse(raw_url).map_err(|_| "Invalid MCP URL.".to_string())?;
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
                "MCP HTTPS endpoints cannot resolve to local or private addresses.".to_string(),
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
        Implementation::new("lain42-agent-companion", env!("CARGO_PKG_VERSION")),
    )
}
fn lifecycle() -> ClientLifecycleMode {
    ClientLifecycleMode::Auto {
        preferred_versions: vec![ProtocolVersion::V_2026_07_28],
        legacy_version: Some(ProtocolVersion::V_2025_11_25),
    }
}

fn bearer_token(server: &McpServerConfig) -> Result<Option<String>, String> {
    let Some(name) = server.bearer_token_env.as_deref() else {
        return Ok(None);
    };
    let token = env::var(name)
        .map_err(|_| "MCP bearer token environment variable is not set.".to_string())?;
    let token = token.trim();
    if token.is_empty() || token.len() > MAX_TOKEN_BYTES || token.contains(['\r', '\n']) {
        return Err("Invalid MCP bearer token.".to_string());
    }
    Ok(Some(token.to_string()))
}

async fn connect_client(server: &McpServerConfig) -> Result<McpClient, String> {
    match server.transport.as_str() {
        "stdio" => {
            validate_stdio(server)?;
            let command = server.command.as_deref().expect("validated command").trim();
            let transport = BoundedMcpStdioTransport::spawn(
                tokio::process::Command::new(command).configure(|process| {
                    process.args(&server.args);
                }),
                MAX_RESPONSE_BYTES,
            )
            .map_err(|_| "Unable to start the configured MCP command.".to_string())?;
            timeout(
                CONNECT_TIMEOUT,
                client_config().serve_with_lifecycle(transport, lifecycle()),
            )
            .await
            .map_err(|_| "MCP connection timed out.".to_string())?
            .map_err(|_| "MCP initialization failed.".to_string())
        }
        "streamable_http" => {
            let url = validate_http(server)?;
            let (host, address) = resolve_public_endpoint(&url).await?;
            let http_client = reqwest::Client::builder()
                .no_proxy()
                .resolve(&host, address)
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|_| "Unable to create the MCP HTTPS client.".to_string())?;
            let mut config = StreamableHttpClientTransportConfig::with_uri(url)
                .max_concurrent_requests(1)
                .control_request_timeout(CONNECT_TIMEOUT)
                .session_recovery_timeout(CONNECT_TIMEOUT)
                .max_sse_event_size(MAX_RESPONSE_BYTES)
                .reinit_on_expired_session(false);
            if let Some(token) = bearer_token(server)? {
                config = config.auth_header(token);
            }
            let transport = StreamableHttpClientTransport::with_client(http_client, config);
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

fn tool_descriptor(server: &McpServerConfig, tool: Tool) -> Option<McpToolDescriptor> {
    let name = tool.name.as_ref();
    if !server.allowed_tools.iter().any(|allowed| allowed == name)
        || name.is_empty()
        || name.len() > MAX_TOOL_NAME_BYTES
        || name.chars().any(char::is_control)
    {
        return None;
    }
    let schema = Value::Object(tool.input_schema.as_ref().clone());
    let input_schema = match serde_json::to_vec(&schema) {
        Ok(bytes) if bytes.len() <= MAX_SCHEMA_BYTES => schema,
        _ => json!({"type":"object", "additionalProperties":true}),
    };
    Some(McpToolDescriptor {
        server_id: server.server_id.clone(),
        server_name: server.name.clone(),
        name: name.to_string(),
        description: tool
            .description
            .as_deref()
            .filter(|value| !value.is_empty())
            .map(|value| bounded_text(value, MAX_DESCRIPTION_BYTES)),
        input_schema,
    })
}

async fn list_bounded_tools(
    client: &McpClient,
    server: &McpServerConfig,
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
                .filter_map(|tool| tool_descriptor(server, tool))
                .take(MAX_TOOLS_PER_SERVER.saturating_sub(tools.len())),
        );
        if tools.len() >= MAX_TOOLS_PER_SERVER || page.next_cursor.is_none() {
            break;
        }
        cursor = page.next_cursor;
    }
    Ok(tools)
}

fn ensure_catalog_bounds(servers: &[McpServerDescriptor]) -> Result<(), String> {
    if servers
        .iter()
        .map(|server| server.tools.len())
        .sum::<usize>()
        > MAX_TOTAL_TOOLS
    {
        return Err("MCP tool catalog exceeds its tool limit.".to_string());
    }
    if serde_json::to_vec(servers)
        .map_err(|_| "Unable to measure the MCP tool catalog.".to_string())?
        .len()
        > MAX_CATALOG_BYTES
    {
        return Err("MCP tool catalog exceeds its byte limit.".to_string());
    }
    Ok(())
}

async fn describe_server(server: &McpServerConfig) -> Result<McpServerDescriptor, String> {
    let mut client = connect_client(server).await?;
    let tools = timeout(CONNECT_TIMEOUT, list_bounded_tools(&client, server))
        .await
        .map_err(|_| "MCP tools/list timed out.".to_string())??;
    let _ = client.close_with_timeout(CLOSE_TIMEOUT).await;
    Ok(McpServerDescriptor {
        server_id: server.server_id.clone(),
        name: server.name.clone(),
        transport: server.transport.clone(),
        tools,
    })
}

impl McpRuntime {
    fn from_env() -> Result<Self, String> {
        Ok(Self {
            runtime: tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
                .map_err(|_| "Unable to start the MCP runtime.".to_string())?,
            servers: load_mcp_servers()?,
        })
    }

    fn list(&self) -> Result<Value, String> {
        let mut descriptors = Vec::with_capacity(self.servers.len());
        for server in self.servers.values() {
            descriptors.push(self.runtime.block_on(describe_server(server))?);
        }
        ensure_catalog_bounds(&descriptors)?;
        Ok(json!({"servers": descriptors}))
    }

    fn call(&self, params: Value) -> Result<Value, String> {
        let request: McpCallRequest =
            serde_json::from_value(params).map_err(|_| "Invalid mcp.call request.".to_string())?;
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
            return Err("MCP tool arguments exceed the byte limit.".to_string());
        }
        let server = self
            .servers
            .get(&server_id)
            .ok_or_else(|| "MCP server is not configured on this node.".to_string())?;
        if !server
            .allowed_tools
            .iter()
            .any(|allowed| allowed == &tool_name)
        {
            return Err("MCP tool is not allowed on this node.".to_string());
        }
        let call_timeout =
            Duration::from_millis(request.timeout_ms.unwrap_or(30_000).clamp(1, 30_000));
        self.runtime.block_on(async {
            let mut client = connect_client(server).await?;
            let tools = timeout(CONNECT_TIMEOUT, list_bounded_tools(&client, server))
                .await
                .map_err(|_| "MCP tools/list timed out.".to_string())??;
            if !tools.iter().any(|tool| tool.name == tool_name) {
                let _ = client.close_with_timeout(CLOSE_TIMEOUT).await;
                return Err("MCP tool is not available from this server.".to_string());
            }
            let result = timeout(
                call_timeout,
                client.call_tool(CallToolRequestParams::new(tool_name).with_arguments(arguments)),
            )
            .await;
            let value = match result {
                Ok(result) => {
                    serde_json::to_value(result.map_err(|_| "MCP tools/call failed.".to_string())?)
                        .map_err(|_| "Unable to encode MCP tool result.".to_string())?
                }
                Err(_) => {
                    client.cancellation_token().cancel();
                    let _ = client.close_with_timeout(CLOSE_TIMEOUT).await;
                    return Err("MCP tools/call timed out.".to_string());
                }
            };
            let _ = client.close_with_timeout(CLOSE_TIMEOUT).await;
            if serde_json::to_vec(&value)
                .map_err(|_| "Unable to measure MCP tool result.".to_string())?
                .len()
                > MAX_RESPONSE_BYTES
            {
                return Err("MCP tool result exceeds the byte limit.".to_string());
            }
            Ok(value)
        })
    }
}

fn send(socket: &mut BridgeSocket, envelope: BridgeEnvelope) -> Result<(), String> {
    let text = serde_json::to_string(&envelope)
        .map_err(|_| "Unable to encode bridge message.".to_string())?;
    if text.len() > MAX_MESSAGE_BYTES {
        return Err("Agent bridge message exceeds the size limit".to_string());
    }
    socket
        .send(Message::Text(text.into()))
        .map_err(|_| "Unable to send bridge message.".to_string())
}

fn run_connection(
    bridge_url: &Url,
    credential: &str,
    device_id: i64,
    credentials: &ProfileCredentials,
    mcp: &McpRuntime,
) -> Result<(), String> {
    let (mut socket, _) = connect(bridge_url.as_str())
        .map_err(|_| "Unable to connect to Lain42 Agent.".to_string())?;
    send(
        &mut socket,
        BridgeEnvelope {
            message_type: "hello".to_string(),
            protocol_version: Some(AGENT_BRIDGE_PROTOCOL_VERSION),
            capabilities: Some(vec![
                "github.read".to_string(),
                "developer.cli.status".to_string(),
                "workspace.read".to_string(),
                "code.search".to_string(),
                "vcs.history".to_string(),
                "mcp.list".to_string(),
                "mcp.call".to_string(),
            ]),
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
            .map_err(|_| "Agent bridge disconnected.".to_string())?;
        let Message::Text(text) = message else {
            continue;
        };
        if text.len() > MAX_MESSAGE_BYTES {
            return Err("Agent bridge message exceeds the size limit".to_string());
        }
        let envelope: BridgeEnvelope = serde_json::from_str(&text)
            .map_err(|_| "Agent bridge returned invalid JSON".to_string())?;
        match envelope.message_type.as_str() {
            "hello_ack" => {
                if let Some(version) = envelope.protocol_version {
                    if version != AGENT_BRIDGE_PROTOCOL_VERSION {
                        return Err(format!(
                            "Incompatible agent bridge protocol v{version}; expected v{AGENT_BRIDGE_PROTOCOL_VERSION}."
                        ));
                    }
                }
            }
            "ping" => send(
                &mut socket,
                BridgeEnvelope {
                    message_type: "pong".to_string(),
                    protocol_version: None,
                    capabilities: None,
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
                let params = envelope.params.unwrap_or(Value::Object(Default::default()));
                let outcome = match operation.as_str() {
                    "mcp.list" => mcp.list(),
                    "mcp.call" => mcp.call(params),
                    _ => execute_operation(
                        &OperationRequest {
                            operation,
                            params,
                            timeout_ms: Some(30_000),
                        },
                        Some(credentials),
                        &CancellationToken::new(),
                    )
                    .and_then(|result| {
                        serde_json::to_value(result)
                            .map_err(|_| "Unable to encode tool result.".to_string())
                    }),
                };
                match outcome {
                    Ok(result) => send(
                        &mut socket,
                        BridgeEnvelope {
                            message_type: "tool_result".to_string(),
                            protocol_version: None,
                            capabilities: None,
                            request_id: Some(request_id),
                            device_id: Some(device_id),
                            credential: None,
                            operation: None,
                            params: None,
                            result: Some(result),
                            error: None,
                        },
                    )?,
                    Err(error) => send(
                        &mut socket,
                        BridgeEnvelope {
                            message_type: "tool_error".to_string(),
                            protocol_version: None,
                            capabilities: None,
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
    let mcp = McpRuntime::from_env()?;
    let bridge_url =
        env::var("LAIN42_AGENT_BRIDGE_URL").unwrap_or_else(|_| DEFAULT_BRIDGE_URL.to_string());
    let bridge_url = Url::parse(&bridge_url).map_err(|_| "Invalid bridge URL.".to_string())?;
    if bridge_url.scheme() != "wss" {
        return Err("The headless companion requires a wss:// bridge URL".to_string());
    }
    let mut delay = Duration::from_secs(2);
    loop {
        match run_connection(&bridge_url, &credential, device_id, &credentials, &mcp) {
            Ok(()) => delay = Duration::from_secs(2),
            Err(error) => {
                eprintln!("{error}; retrying in {}s", delay.as_secs());
                thread::sleep(delay);
                delay = (delay * 2).min(Duration::from_secs(60));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stdio_server() -> McpServerConfig {
        McpServerConfig {
            server_id: "workspace".to_string(),
            name: "Workspace".to_string(),
            transport: "stdio".to_string(),
            command: Some("mcp-workspace".to_string()),
            args: vec!["--read-only".to_string()],
            url: None,
            bearer_token_env: None,
            allowed_tools: vec!["read_file".to_string()],
        }
    }

    #[test]
    fn config_requires_explicit_tools_and_safe_ids() {
        let mut server = stdio_server();
        assert!(validate_server(&server).is_ok());
        server.allowed_tools.clear();
        assert!(validate_server(&server).is_err());
        server.server_id = "workspace;rm".to_string();
        assert!(validate_server(&server).is_err());
    }

    #[test]
    fn bridge_accepts_additive_server_hello_fields() {
        let envelope: BridgeEnvelope = serde_json::from_str(
            r#"{"type":"hello_ack","protocol_version":1,"capabilities":[],"device_id":42,"desktop_connected":false}"#,
        )
        .expect("additive bridge fields must not break older clients");

        assert_eq!(envelope.message_type, "hello_ack");
        assert_eq!(envelope.protocol_version, Some(1));
        assert_eq!(envelope.device_id, Some(42));
    }

    #[test]
    fn stdio_is_an_argv_not_a_shell_fragment() {
        let mut server = stdio_server();
        server.command = Some("mcp\0workspace".to_string());
        assert!(validate_stdio(&server).is_err());
        server.command = Some("mcp-workspace".to_string());
        server.args = vec!["ok\nnot-ok".to_string()];
        assert!(validate_stdio(&server).is_err());
    }

    #[test]
    fn private_and_cleartext_http_endpoints_are_rejected() {
        let mut server = stdio_server();
        server.transport = "streamable_http".to_string();
        server.command = None;
        server.args.clear();
        server.url = Some("http://127.0.0.1/mcp".to_string());
        assert!(validate_http(&server).is_err());
        server.url = Some("https://[::ffff:10.0.0.1]/mcp".to_string());
        assert!(validate_http(&server).is_err());
        server.url = Some("https://mcp.example.test/mcp".to_string());
        assert!(validate_http(&server).is_ok());
        assert!(forbidden_ip("100.64.0.1".parse().unwrap()));
    }

    #[test]
    fn output_bounds_are_utf8_safe() {
        let value = format!("{}€", "a".repeat(MAX_DESCRIPTION_BYTES));
        let bounded = bounded_text(&value, MAX_DESCRIPTION_BYTES);
        assert!(bounded.len() <= MAX_DESCRIPTION_BYTES);
        assert!(bounded.is_char_boundary(bounded.len()));
    }
}
