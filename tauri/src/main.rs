#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    collections::HashMap,
    env, fs,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{webview::WebviewWindowBuilder, AppHandle, Manager, State, WebviewUrl};
use url::Url;

mod mcp_client;
mod tool_runtime;

use tool_runtime::{
    cli_tool_spec, detect_cli_tool, execute_operation, workspace_status, CancellationToken,
    CliExecRequest, CliExecResult, DeveloperToolStatus, OperationRequest, ProfileCredentials,
    CLI_TOOL_REGISTRY,
};

const DEFAULT_AGENT_URL: &str = "https://api.lain42.top/agent";
const ACCOUNT_SESSION_CACHE_TTL: Duration = Duration::from_secs(30);
const MAX_VERIFIED_ACCOUNT_SESSIONS: usize = 128;
const MAX_ACCOUNT_VERIFICATION_RESPONSE_BYTES: u64 = 64 * 1024;

#[derive(Default)]
pub struct VerifiedAccountSessions(Mutex<HashMap<(i64, [u8; 32]), Instant>>);

fn account_session_cache_key(user_id: i64, access_token: &str) -> (i64, [u8; 32]) {
    (user_id, Sha256::digest(access_token.as_bytes()).into())
}

fn response_account_id(response: &serde_json::Value) -> Option<i64> {
    response.pointer("/data/id")?.as_i64().filter(|id| *id > 0)
}

fn validate_response_account(response: &serde_json::Value, user_id: i64) -> Result<(), String> {
    if response.get("success").and_then(serde_json::Value::as_bool) == Some(true)
        && response_account_id(response) == Some(user_id)
    {
        Ok(())
    } else {
        Err("The signed-in account does not match this desktop profile.".to_string())
    }
}

pub(crate) async fn verify_account_session(
    state: &State<'_, VerifiedAccountSessions>,
    user_id: i64,
    access_token: &str,
) -> Result<i64, String> {
    let user_id = validate_account_id(user_id)?;
    if !(16..=4096).contains(&access_token.len()) || access_token.chars().any(char::is_control) {
        return Err("A valid signed-in session is required for desktop tools.".to_string());
    }

    let cache_key = account_session_cache_key(user_id, access_token);
    let now = Instant::now();
    {
        let mut cache = state
            .0
            .lock()
            .map_err(|_| "Account session state is unavailable.".to_string())?;
        cache.retain(|_, expires_at| *expires_at > now);
        if cache.contains_key(&cache_key) {
            return Ok(user_id);
        }
    }

    let self_url = agent_url()
        .join("/api/user/self")
        .map_err(|_| "Unable to resolve the account verification endpoint.".to_string())?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Unable to prepare account verification.".to_string())?;
    let response = client
        .get(self_url)
        .bearer_auth(access_token)
        .header("Cache-Control", "no-store")
        .send()
        .await
        .map_err(|_| "Unable to verify the signed-in account with New API.".to_string())?;
    if !response.status().is_success() {
        return Err("The signed-in account could not be verified. Sign in again.".to_string());
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_ACCOUNT_VERIFICATION_RESPONSE_BYTES)
    {
        return Err("New API returned an invalid account verification response.".to_string());
    }
    let response = response
        .bytes()
        .await
        .map_err(|_| "New API returned an invalid account verification response.".to_string())?;
    if response.len() as u64 > MAX_ACCOUNT_VERIFICATION_RESPONSE_BYTES {
        return Err("New API returned an invalid account verification response.".to_string());
    }
    let response = serde_json::from_slice::<serde_json::Value>(&response)
        .map_err(|_| "New API returned an invalid account verification response.".to_string())?;
    validate_response_account(&response, user_id)?;

    let mut cache = state
        .0
        .lock()
        .map_err(|_| "Account session state is unavailable.".to_string())?;
    cache.retain(|_, expires_at| *expires_at > Instant::now());
    if cache.len() >= MAX_VERIFIED_ACCOUNT_SESSIONS {
        if let Some(oldest_key) = cache
            .iter()
            .min_by(|(_, left), (_, right)| left.cmp(right))
            .map(|(key, _)| *key)
        {
            cache.remove(&oldest_key);
        }
    }
    cache.insert(cache_key, Instant::now() + ACCOUNT_SESSION_CACHE_TTL);
    Ok(user_id)
}

#[derive(Default)]
struct AgentDeviceState(Mutex<HashMap<i64, AgentDeviceSession>>);

const AGENT_DEVICE_SESSION_FILE: &str = "agent-device.json";

#[derive(Clone, Debug, Deserialize, Serialize)]
struct AgentDeviceSession {
    profile_id: String,
    account_id: i64,
    device_id: i64,
    credential: String,
}

fn agent_url() -> Url {
    env::var("LAIN42_DESKTOP_URL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .and_then(|value| Url::parse(&value).ok())
        .unwrap_or_else(|| Url::parse(DEFAULT_AGENT_URL).expect("default Agent URL is valid"))
}

#[derive(Debug, Serialize)]
struct GhAuthStatus {
    profile_id: String,
    gh_config_dir: String,
    installed: bool,
    authenticated: bool,
    account: Option<String>,
    message: String,
    login_command_windows: String,
    login_command_unix: String,
}

#[tauri::command]
async fn tool_status(
    app: AppHandle,
    verified_sessions: State<'_, VerifiedAccountSessions>,
    user_id: i64,
    access_token: String,
    tool_ids: Option<Vec<String>>,
) -> Result<Vec<DeveloperToolStatus>, String> {
    let user_id = verify_account_session(&verified_sessions, user_id, &access_token).await?;
    let ids = tool_ids.unwrap_or_else(|| {
        CLI_TOOL_REGISTRY
            .iter()
            .map(|spec| spec.id.to_string())
            .collect()
    });
    let credentials = profile_credentials(&app, user_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        Ok(ids
            .into_iter()
            .filter_map(|id| {
                if id == "workspace-files" {
                    Some(workspace_status())
                } else {
                    cli_tool_spec(&id)
                        .ok()
                        .map(|spec| detect_cli_tool(spec.id, Some(&credentials)))
                }
            })
            .collect())
    })
    .await
    .map_err(|_| "Developer tool detection failed.".to_string())?
}

#[tauri::command]
async fn cli_exec(
    app: AppHandle,
    verified_sessions: State<'_, VerifiedAccountSessions>,
    user_id: i64,
    access_token: String,
    request: CliExecRequest,
) -> Result<CliExecResult, String> {
    let user_id = verify_account_session(&verified_sessions, user_id, &access_token).await?;
    let credentials = profile_credentials(&app, user_id)?;
    let request = OperationRequest {
        operation: request.operation,
        params: request.params,
        timeout_ms: request.timeout_ms,
    };
    tauri::async_runtime::spawn_blocking(move || {
        execute_operation(&request, Some(&credentials), &CancellationToken::new())
    })
    .await
    .map_err(|_| "The local CLI worker failed.".to_string())?
}

#[tauri::command]
async fn agent_device_credential_get(
    app: AppHandle,
    state: State<'_, AgentDeviceState>,
    verified_sessions: State<'_, VerifiedAccountSessions>,
    user_id: i64,
    access_token: String,
) -> Result<Option<String>, String> {
    let user_id = verify_account_session(&verified_sessions, user_id, &access_token).await?;
    Ok(current_agent_device_session(&app, &state, user_id).map(|value| value.credential))
}

#[tauri::command]
async fn agent_device_id_get(
    app: AppHandle,
    state: State<'_, AgentDeviceState>,
    verified_sessions: State<'_, VerifiedAccountSessions>,
    user_id: i64,
    access_token: String,
) -> Result<Option<i64>, String> {
    let user_id = verify_account_session(&verified_sessions, user_id, &access_token).await?;
    Ok(current_agent_device_session(&app, &state, user_id).map(|value| value.device_id))
}

#[tauri::command(rename_all = "camelCase")]
async fn agent_device_credential_set(
    app: AppHandle,
    state: State<'_, AgentDeviceState>,
    verified_sessions: State<'_, VerifiedAccountSessions>,
    credential: String,
    device_id: i64,
    user_id: i64,
    access_token: String,
) -> Result<(), String> {
    let user_id = verify_account_session(&verified_sessions, user_id, &access_token).await?;
    let credential = credential.trim().to_string();
    if !(32..=256).contains(&credential.len()) || device_id <= 0 {
        return Err("Invalid agent device credential.".to_string());
    }
    let profile_id = desktop_profile_id();
    let session = AgentDeviceSession {
        profile_id,
        account_id: validate_account_id(user_id)?,
        device_id,
        credential,
    };
    persist_agent_device_session(&app, &session)?;
    let mut current = state
        .0
        .lock()
        .map_err(|_| "Agent device state is unavailable.".to_string())?;
    current.insert(user_id, session);
    Ok(())
}

#[tauri::command]
async fn agent_device_credential_clear(
    app: AppHandle,
    state: State<'_, AgentDeviceState>,
    verified_sessions: State<'_, VerifiedAccountSessions>,
    user_id: i64,
    access_token: String,
) -> Result<(), String> {
    let user_id = verify_account_session(&verified_sessions, user_id, &access_token).await?;
    let profile_id = desktop_profile_id();
    remove_agent_device_session(&app, &profile_id, user_id)?;
    let mut current = state
        .0
        .lock()
        .map_err(|_| "Agent device state is unavailable.".to_string())?;
    current.remove(&user_id);
    Ok(())
}

fn account_data_directory(
    base: &Path,
    profile_id: &str,
    account_id: i64,
) -> Result<PathBuf, String> {
    validate_profile_id(profile_id)?;
    validate_account_id(account_id)?;
    Ok(base
        .join("profiles")
        .join(profile_id)
        .join("accounts")
        .join(format!("user-{account_id}")))
}

fn validate_account_id(account_id: i64) -> Result<i64, String> {
    if account_id > 0 {
        Ok(account_id)
    } else {
        Err("A signed-in account is required for desktop credentials.".to_string())
    }
}

fn agent_device_session_path(
    app: &AppHandle,
    profile_id: &str,
    account_id: i64,
) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Unable to resolve app data directory: {error}"))?;
    let profile_dir = account_data_directory(&base, profile_id, account_id)?;
    fs::create_dir_all(&profile_dir)
        .map_err(|error| format!("Unable to create agent profile: {error}"))?;
    restrict_agent_profile_directory(&profile_dir)?;
    Ok(profile_dir.join(AGENT_DEVICE_SESSION_FILE))
}

fn valid_agent_device_session(
    session: &AgentDeviceSession,
    profile_id: &str,
    account_id: i64,
) -> bool {
    session.profile_id == profile_id
        && session.account_id == account_id
        && account_id > 0
        && session.device_id > 0
        && (32..=256).contains(&session.credential.len())
        && !session
            .credential
            .chars()
            .any(|character| character.is_control())
}

fn load_agent_device_session(
    app: &AppHandle,
    profile_id: &str,
    account_id: i64,
) -> Option<AgentDeviceSession> {
    let path = agent_device_session_path(app, profile_id, account_id).ok()?;
    let bytes = fs::read(path).ok()?;
    let session = serde_json::from_slice::<AgentDeviceSession>(&bytes).ok()?;
    valid_agent_device_session(&session, profile_id, account_id).then_some(session)
}

fn current_agent_device_session(
    app: &AppHandle,
    state: &State<'_, AgentDeviceState>,
    account_id: i64,
) -> Option<AgentDeviceSession> {
    let account_id = validate_account_id(account_id).ok()?;
    let profile_id = desktop_profile_id();
    let mut current = state.0.lock().ok()?;
    if let Some(session) = current.get(&account_id) {
        if valid_agent_device_session(session, &profile_id, account_id) {
            return Some(session.clone());
        }
    }
    let loaded = load_agent_device_session(app, &profile_id, account_id);
    if let Some(session) = &loaded {
        current.insert(account_id, session.clone());
    } else {
        current.remove(&account_id);
    }
    loaded
}

fn persist_agent_device_session(
    app: &AppHandle,
    session: &AgentDeviceSession,
) -> Result<(), String> {
    if !valid_agent_device_session(session, &session.profile_id, session.account_id) {
        return Err("Invalid agent device session.".to_string());
    }
    let path = agent_device_session_path(app, &session.profile_id, session.account_id)?;
    let bytes = serde_json::to_vec(session)
        .map_err(|error| format!("Unable to encode agent device session: {error}"))?;
    write_agent_device_file(&path, &bytes)?;
    restrict_agent_device_file(&path)?;
    Ok(())
}

#[cfg(unix)]
fn write_agent_device_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut options = fs::OpenOptions::new();
    options.create(true).truncate(true).write(true).mode(0o600);
    let mut file = options
        .open(path)
        .map_err(|error| format!("Unable to persist agent device session: {error}"))?;
    file.write_all(bytes)
        .map_err(|error| format!("Unable to persist agent device session: {error}"))
}

#[cfg(not(unix))]
fn write_agent_device_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    fs::write(path, bytes)
        .map_err(|error| format!("Unable to persist agent device session: {error}"))
}

fn remove_agent_device_session(
    app: &AppHandle,
    profile_id: &str,
    account_id: i64,
) -> Result<(), String> {
    let path = agent_device_session_path(app, profile_id, account_id)?;
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Unable to remove agent device session: {error}")),
    }
}

#[cfg(unix)]
fn restrict_agent_device_file(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("Unable to restrict agent device session: {error}"))
}

#[cfg(not(unix))]
fn restrict_agent_device_file(_path: &Path) -> Result<(), String> {
    // Windows app-local data inherits the current user's ACL. The file never
    // leaves that profile directory and is never returned to the web page.
    Ok(())
}

#[cfg(unix)]
fn restrict_agent_profile_directory(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|error| format!("Unable to restrict agent account directory: {error}"))
}

#[cfg(not(unix))]
fn restrict_agent_profile_directory(_path: &Path) -> Result<(), String> {
    // App-local data inherits the current OS account's ACL on Windows.
    Ok(())
}

fn validate_profile_id(profile_id: &str) -> Result<(), String> {
    if (1..=64).contains(&profile_id.len())
        && profile_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        Ok(())
    } else {
        Err("Invalid desktop profile id.".to_string())
    }
}

fn gh_config_dir(app: &AppHandle, account_id: i64) -> Result<PathBuf, String> {
    let profile_id = desktop_profile_id();
    let base = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Unable to resolve app data directory: {error}"))?;
    let account_dir = account_data_directory(&base, &profile_id, account_id)?;
    let path = account_dir.join("gh");
    fs::create_dir_all(&path).map_err(|error| format!("Unable to create CLI profile: {error}"))?;
    restrict_agent_profile_directory(&account_dir)?;
    restrict_agent_profile_directory(&path)?;
    Ok(path)
}

fn profile_credentials(app: &AppHandle, account_id: i64) -> Result<ProfileCredentials, String> {
    let profile_id = format!("user-{}", validate_account_id(account_id)?);
    let config_dir = gh_config_dir(app, account_id)?;
    Ok(ProfileCredentials::new(profile_id, config_dir))
}

fn desktop_profile_id() -> String {
    if let Some(profile) = env::var("LAIN42_DESKTOP_PROFILE")
        .ok()
        .filter(|value| validate_profile_id(value).is_ok())
    {
        return profile;
    }

    let os_user = env::var("USERNAME")
        .or_else(|_| env::var("USER"))
        .ok()
        .map(|value| {
            value
                .chars()
                .filter(|character| {
                    character.is_ascii_alphanumeric() || matches!(character, '-' | '_')
                })
                .take(56)
                .collect::<String>()
        })
        .filter(|value| !value.is_empty());

    os_user
        .map(|value| format!("os-{value}"))
        .filter(|value| validate_profile_id(value).is_ok())
        .unwrap_or_else(|| "default".to_string())
}

fn webview_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Unable to resolve app data directory: {error}"))?;
    let path = base
        .join("profiles")
        .join(desktop_profile_id())
        .join("webview");
    fs::create_dir_all(&path).map_err(|error| format!("Unable to create web profile: {error}"))?;
    Ok(path)
}

fn validate_repo(repo: &str) -> Result<(), String> {
    let valid = repo.len() <= 200
        && repo.split('/').count() == 2
        && repo.split('/').all(|part| {
            !part.is_empty()
                && part
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        });
    if valid {
        Ok(())
    } else {
        Err("Repository must look like owner/name.".to_string())
    }
}

fn validate_limit(limit: u8) -> Result<u8, String> {
    if (1..=50).contains(&limit) {
        Ok(limit)
    } else {
        Err("Limit must be between 1 and 50.".to_string())
    }
}

fn gh_operation(
    app: &AppHandle,
    user_id: i64,
    operation: &str,
    params: serde_json::Value,
) -> Result<CliExecResult, String> {
    let credentials = profile_credentials(app, user_id)?;
    let request = OperationRequest {
        operation: operation.to_string(),
        params,
        timeout_ms: None,
    };
    execute_operation(&request, Some(&credentials), &CancellationToken::new())
}

#[tauri::command]
async fn gh_auth_status(
    app: AppHandle,
    verified_sessions: State<'_, VerifiedAccountSessions>,
    user_id: i64,
    access_token: String,
) -> Result<GhAuthStatus, String> {
    let user_id = verify_account_session(&verified_sessions, user_id, &access_token).await?;
    let profile_id = format!("user-{}", validate_account_id(user_id)?);
    let config_dir = gh_config_dir(&app, user_id)?;
    let config = config_dir.display().to_string();
    let login_command_windows = format!(
        "$env:GH_CONFIG_DIR=\"{}\"; gh auth login",
        config.replace('"', "")
    );
    let login_command_unix = format!(
        "GH_CONFIG_DIR=\"{}\" gh auth login",
        config.replace('"', "")
    );
    let operation_app = app.clone();
    let output = tauri::async_runtime::spawn_blocking(move || {
        gh_operation(
            &operation_app,
            user_id,
            "github.auth.status",
            serde_json::json!({}),
        )
    })
    .await
    .map_err(|_| "GitHub CLI status check failed.".to_string())??;

    let text = output.stdout.as_str();
    let error_text = output.stderr.as_str();
    let account = text.lines().chain(error_text.lines()).find_map(|line| {
        let marker = "account ";
        let start = line.find(marker)? + marker.len();
        let value = line[start..]
            .split_whitespace()
            .next()?
            .trim_matches(|character| matches!(character, '(' | ')' | '[' | ']'));
        (!value.is_empty()).then(|| value.to_string())
    });

    Ok(GhAuthStatus {
        profile_id,
        gh_config_dir: config,
        installed: true,
        authenticated: matches!(output.status, tool_runtime::ExecutionStatus::Succeeded),
        account,
        message: if matches!(output.status, tool_runtime::ExecutionStatus::Succeeded) {
            "GitHub CLI is authenticated for this desktop profile.".to_string()
        } else {
            "Run the profile-specific login command in a terminal to connect your own GitHub account."
                .to_string()
        },
        login_command_windows,
        login_command_unix,
    })
}

#[tauri::command]
async fn gh_search_repositories(
    app: AppHandle,
    verified_sessions: State<'_, VerifiedAccountSessions>,
    user_id: i64,
    access_token: String,
    query: String,
    limit: u8,
) -> Result<serde_json::Value, String> {
    let user_id = verify_account_session(&verified_sessions, user_id, &access_token).await?;
    let query = query.trim();
    if query.is_empty() || query.len() > 200 {
        return Err("Search text must contain 1–200 characters.".to_string());
    }
    let limit = validate_limit(limit)?;
    let operation_app = app.clone();
    let params = serde_json::json!({"query": query, "limit": limit});
    let output = tauri::async_runtime::spawn_blocking(move || {
        gh_operation(
            &operation_app,
            user_id,
            "github.repositories.search",
            params,
        )
    })
    .await
    .map_err(|_| "GitHub repository search failed.".to_string())??;
    if !matches!(output.status, tool_runtime::ExecutionStatus::Succeeded) {
        return Err(output.stderr.trim().to_string());
    }
    serde_json::from_str(&output.stdout)
        .map_err(|error| format!("Invalid GitHub response: {error}"))
}

#[tauri::command]
async fn gh_list_issues(
    app: AppHandle,
    verified_sessions: State<'_, VerifiedAccountSessions>,
    user_id: i64,
    access_token: String,
    repo: String,
    limit: u8,
) -> Result<serde_json::Value, String> {
    let user_id = verify_account_session(&verified_sessions, user_id, &access_token).await?;
    validate_repo(repo.trim())?;
    validate_limit(limit)?;
    let operation_app = app.clone();
    let params = serde_json::json!({"repo": repo.trim(), "state": "open", "limit": limit, "sort": "updated"});
    let output = tauri::async_runtime::spawn_blocking(move || {
        gh_operation(&operation_app, user_id, "github.issues.list", params)
    })
    .await
    .map_err(|_| "GitHub issue lookup failed.".to_string())??;
    if !matches!(output.status, tool_runtime::ExecutionStatus::Succeeded) {
        return Err(output.stderr.trim().to_string());
    }
    serde_json::from_str(&output.stdout)
        .map_err(|error| format!("Invalid GitHub response: {error}"))
}

#[tauri::command]
async fn gh_list_pull_requests(
    app: AppHandle,
    verified_sessions: State<'_, VerifiedAccountSessions>,
    user_id: i64,
    access_token: String,
    repo: String,
    limit: u8,
) -> Result<serde_json::Value, String> {
    let user_id = verify_account_session(&verified_sessions, user_id, &access_token).await?;
    validate_repo(repo.trim())?;
    validate_limit(limit)?;
    let operation_app = app.clone();
    let params = serde_json::json!({"repo": repo.trim(), "state": "open", "limit": limit, "sort": "updated"});
    let output = tauri::async_runtime::spawn_blocking(move || {
        gh_operation(&operation_app, user_id, "github.pull_requests.list", params)
    })
    .await
    .map_err(|_| "GitHub pull request lookup failed.".to_string())??;
    if !matches!(output.status, tool_runtime::ExecutionStatus::Succeeded) {
        return Err(output.stderr.trim().to_string());
    }
    serde_json::from_str(&output.stdout)
        .map_err(|error| format!("Invalid GitHub response: {error}"))
}

fn main() {
    tauri::Builder::default()
        .manage(AgentDeviceState::default())
        .manage(VerifiedAccountSessions::default())
        .manage(mcp_client::McpState::default())
        .setup(|app| {
            let app_handle = app.handle().clone();
            let webview_data_dir =
                webview_data_dir(&app_handle).expect("web profile path is valid");
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(agent_url()))
                .title("Lain42 Agent")
                .inner_size(1280.0, 820.0)
                .min_inner_size(900.0, 620.0)
                .resizable(true)
                .center()
                .data_directory(webview_data_dir)
                .build()?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            gh_auth_status,
            gh_search_repositories,
            gh_list_issues,
            gh_list_pull_requests,
            tool_status,
            cli_exec,
            agent_device_credential_get,
            agent_device_id_get,
            agent_device_credential_set,
            agent_device_credential_clear,
            mcp_client::mcp_connect,
            mcp_client::mcp_list,
            mcp_client::mcp_call,
            mcp_client::mcp_disconnect
        ])
        .run(tauri::generate_context!())
        .expect("error while running Lain42 Agent");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(
        profile_id: &str,
        account_id: i64,
        credential: &str,
        device_id: i64,
    ) -> AgentDeviceSession {
        AgentDeviceSession {
            profile_id: profile_id.to_string(),
            account_id,
            device_id,
            credential: credential.to_string(),
        }
    }

    #[test]
    fn device_sessions_are_scoped_to_the_active_profile() {
        let credential = "c".repeat(32);
        let current = session("work", 7, &credential, 8);
        assert!(valid_agent_device_session(&current, "work", 7));
        assert!(!valid_agent_device_session(&current, "personal", 7));
        assert!(!valid_agent_device_session(&current, "work", 9));
    }

    #[test]
    fn device_session_rejects_malformed_credentials() {
        assert!(!valid_agent_device_session(
            &session("work", 7, "short", 8),
            "work",
            7
        ));
        assert!(!valid_agent_device_session(
            &session("work", 7, &"c".repeat(32), 0),
            "work",
            7
        ));
        assert!(!valid_agent_device_session(
            &session("work", 7, &format!("{}\n", "c".repeat(31)), 8),
            "work",
            7
        ));
    }

    #[test]
    fn account_local_state_uses_distinct_directories() {
        let base = Path::new("app-data");
        let first = account_data_directory(base, "desktop", 7).unwrap();
        let second = account_data_directory(base, "desktop", 9).unwrap();
        assert_ne!(first, second);
        assert!(first.ends_with(Path::new("profiles/desktop/accounts/user-7")));
        assert!(second.ends_with(Path::new("profiles/desktop/accounts/user-9")));
    }

    #[test]
    fn account_local_state_rejects_guest_and_non_positive_ids() {
        for account_id in [0, -1] {
            assert!(validate_account_id(account_id).is_err());
            assert!(account_data_directory(Path::new("app-data"), "desktop", account_id).is_err());
        }
    }

    #[test]
    fn account_verification_requires_the_matching_authenticated_user() {
        assert!(validate_response_account(
            &serde_json::json!({"success": true, "data": {"id": 7}}),
            7
        )
        .is_ok());
        assert!(validate_response_account(
            &serde_json::json!({"success": true, "data": {"id": 9}}),
            7
        )
        .is_err());
        assert!(validate_response_account(
            &serde_json::json!({"success": false, "data": {"id": 7}}),
            7
        )
        .is_err());
        assert!(validate_response_account(&serde_json::json!({"data": {}}), 7).is_err());
    }

    #[test]
    fn verified_session_cache_is_scoped_to_account_and_token() {
        let account_token = account_session_cache_key(7, "account-session-token-7");

        assert_ne!(
            account_token,
            account_session_cache_key(9, "account-session-token-7")
        );
        assert_ne!(
            account_token,
            account_session_cache_key(7, "rotated-account-session-token-7")
        );
    }
}
