#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    env, fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

use serde::{Deserialize, Serialize};
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

#[derive(Default)]
struct AgentDeviceState(Mutex<Option<AgentDeviceSession>>);

const AGENT_DEVICE_SESSION_FILE: &str = "agent-device.json";

#[derive(Clone, Debug, Deserialize, Serialize)]
struct AgentDeviceSession {
    profile_id: String,
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
fn tool_status(app: AppHandle, tool_ids: Option<Vec<String>>) -> Vec<DeveloperToolStatus> {
    let ids = tool_ids.unwrap_or_else(|| {
        CLI_TOOL_REGISTRY
            .iter()
            .map(|spec| spec.id.to_string())
            .collect()
    });
    let credentials = profile_credentials(&app).ok();
    ids.into_iter()
        .filter_map(|id| {
            if id == "workspace-files" {
                Some(workspace_status())
            } else {
                cli_tool_spec(&id)
                    .ok()
                    .map(|spec| detect_cli_tool(spec.id, credentials.as_ref()))
            }
        })
        .collect()
}

#[tauri::command]
fn cli_exec(app: AppHandle, request: CliExecRequest) -> Result<CliExecResult, String> {
    let credentials = profile_credentials(&app).ok();
    let request = OperationRequest {
        operation: request.operation,
        params: request.params,
        timeout_ms: request.timeout_ms,
    };
    execute_operation(&request, credentials.as_ref(), &CancellationToken::new())
}

#[tauri::command]
fn agent_device_credential_get(
    app: AppHandle,
    state: State<'_, AgentDeviceState>,
) -> Option<String> {
    current_agent_device_session(&app, &state).map(|value| value.credential)
}

#[tauri::command]
fn agent_device_id_get(app: AppHandle, state: State<'_, AgentDeviceState>) -> Option<i64> {
    current_agent_device_session(&app, &state).map(|value| value.device_id)
}

#[tauri::command(rename_all = "camelCase")]
fn agent_device_credential_set(
    app: AppHandle,
    state: State<'_, AgentDeviceState>,
    credential: String,
    device_id: i64,
) -> Result<(), String> {
    let credential = credential.trim().to_string();
    if !(32..=256).contains(&credential.len()) || device_id <= 0 {
        return Err("Invalid agent device credential.".to_string());
    }
    let profile_id = desktop_profile_id();
    let session = AgentDeviceSession {
        profile_id,
        device_id,
        credential,
    };
    persist_agent_device_session(&app, &session)?;
    let mut current = state
        .0
        .lock()
        .map_err(|_| "Agent device state is unavailable.".to_string())?;
    *current = Some(session);
    Ok(())
}

#[tauri::command]
fn agent_device_credential_clear(
    app: AppHandle,
    state: State<'_, AgentDeviceState>,
) -> Result<(), String> {
    let profile_id = desktop_profile_id();
    remove_agent_device_session(&app, &profile_id)?;
    let mut current = state
        .0
        .lock()
        .map_err(|_| "Agent device state is unavailable.".to_string())?;
    *current = None;
    Ok(())
}

fn agent_device_session_path(app: &AppHandle, profile_id: &str) -> Result<PathBuf, String> {
    validate_profile_id(profile_id)?;
    let base = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Unable to resolve app data directory: {error}"))?;
    let profile_dir = base.join("profiles").join(profile_id);
    fs::create_dir_all(&profile_dir)
        .map_err(|error| format!("Unable to create agent profile: {error}"))?;
    Ok(profile_dir.join(AGENT_DEVICE_SESSION_FILE))
}

fn valid_agent_device_session(session: &AgentDeviceSession, profile_id: &str) -> bool {
    session.profile_id == profile_id
        && session.device_id > 0
        && (32..=256).contains(&session.credential.len())
        && !session
            .credential
            .chars()
            .any(|character| character.is_control())
}

fn load_agent_device_session(app: &AppHandle, profile_id: &str) -> Option<AgentDeviceSession> {
    let path = agent_device_session_path(app, profile_id).ok()?;
    let bytes = fs::read(path).ok()?;
    let session = serde_json::from_slice::<AgentDeviceSession>(&bytes).ok()?;
    valid_agent_device_session(&session, profile_id).then_some(session)
}

fn current_agent_device_session(
    app: &AppHandle,
    state: &State<'_, AgentDeviceState>,
) -> Option<AgentDeviceSession> {
    let profile_id = desktop_profile_id();
    let mut current = state.0.lock().ok()?;
    if current
        .as_ref()
        .is_some_and(|session| valid_agent_device_session(session, &profile_id))
    {
        return current.clone();
    }
    let loaded = load_agent_device_session(app, &profile_id);
    *current = loaded.clone();
    loaded
}

fn persist_agent_device_session(
    app: &AppHandle,
    session: &AgentDeviceSession,
) -> Result<(), String> {
    if !valid_agent_device_session(session, &session.profile_id) {
        return Err("Invalid agent device session.".to_string());
    }
    let path = agent_device_session_path(app, &session.profile_id)?;
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

fn remove_agent_device_session(app: &AppHandle, profile_id: &str) -> Result<(), String> {
    let path = agent_device_session_path(app, profile_id)?;
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

fn gh_config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let profile_id = desktop_profile_id();
    let base = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Unable to resolve app data directory: {error}"))?;
    let path = base.join("profiles").join(profile_id).join("gh");
    fs::create_dir_all(&path).map_err(|error| format!("Unable to create CLI profile: {error}"))?;
    Ok(path)
}

fn profile_credentials(app: &AppHandle) -> Result<ProfileCredentials, String> {
    let profile_id = desktop_profile_id();
    let config_dir = gh_config_dir(app)?;
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
    operation: &str,
    params: serde_json::Value,
) -> Result<CliExecResult, String> {
    let credentials = profile_credentials(app)?;
    let request = OperationRequest {
        operation: operation.to_string(),
        params,
        timeout_ms: None,
    };
    execute_operation(&request, Some(&credentials), &CancellationToken::new())
}

#[tauri::command]
fn gh_auth_status(app: AppHandle) -> GhAuthStatus {
    let profile_id = desktop_profile_id();
    let config_dir = match gh_config_dir(&app) {
        Ok(path) => path,
        Err(message) => {
            return GhAuthStatus {
                profile_id,
                gh_config_dir: String::new(),
                installed: true,
                authenticated: false,
                account: None,
                message,
                login_command_windows: String::new(),
                login_command_unix: String::new(),
            }
        }
    };
    let config = config_dir.display().to_string();
    let login_command_windows = format!(
        "$env:GH_CONFIG_DIR=\"{}\"; gh auth login",
        config.replace('"', "")
    );
    let login_command_unix = format!(
        "GH_CONFIG_DIR=\"{}\" gh auth login",
        config.replace('"', "")
    );
    let output = match gh_operation(&app, "github.auth.status", serde_json::json!({})) {
        Ok(output) => output,
        Err(message) => {
            return GhAuthStatus {
                profile_id,
                gh_config_dir: config,
                installed: false,
                authenticated: false,
                account: None,
                message,
                login_command_windows,
                login_command_unix,
            }
        }
    };

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

    GhAuthStatus {
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
    }
}

#[tauri::command]
fn gh_search_repositories(
    app: AppHandle,
    query: String,
    limit: u8,
) -> Result<serde_json::Value, String> {
    let query = query.trim();
    if query.is_empty() || query.len() > 200 {
        return Err("Search text must contain 1–200 characters.".to_string());
    }
    let limit = validate_limit(limit)?;
    let output = gh_operation(
        &app,
        "github.repositories.search",
        serde_json::json!({"query": query, "limit": limit}),
    )?;
    if !matches!(output.status, tool_runtime::ExecutionStatus::Succeeded) {
        return Err(output.stderr.trim().to_string());
    }
    serde_json::from_str(&output.stdout)
        .map_err(|error| format!("Invalid GitHub response: {error}"))
}

#[tauri::command]
fn gh_list_issues(app: AppHandle, repo: String, limit: u8) -> Result<serde_json::Value, String> {
    validate_repo(repo.trim())?;
    validate_limit(limit)?;
    let output = gh_operation(
        &app,
        "github.issues.list",
        serde_json::json!({"repo": repo.trim(), "state": "open", "limit": limit, "sort": "updated"}),
    )?;
    if !matches!(output.status, tool_runtime::ExecutionStatus::Succeeded) {
        return Err(output.stderr.trim().to_string());
    }
    serde_json::from_str(&output.stdout)
        .map_err(|error| format!("Invalid GitHub response: {error}"))
}

#[tauri::command]
fn gh_list_pull_requests(
    app: AppHandle,
    repo: String,
    limit: u8,
) -> Result<serde_json::Value, String> {
    validate_repo(repo.trim())?;
    validate_limit(limit)?;
    let output = gh_operation(
        &app,
        "github.pull_requests.list",
        serde_json::json!({"repo": repo.trim(), "state": "open", "limit": limit, "sort": "updated"}),
    )?;
    if !matches!(output.status, tool_runtime::ExecutionStatus::Succeeded) {
        return Err(output.stderr.trim().to_string());
    }
    serde_json::from_str(&output.stdout)
        .map_err(|error| format!("Invalid GitHub response: {error}"))
}

fn main() {
    tauri::Builder::default()
        .manage(AgentDeviceState::default())
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

    fn session(profile_id: &str, credential: &str, device_id: i64) -> AgentDeviceSession {
        AgentDeviceSession {
            profile_id: profile_id.to_string(),
            device_id,
            credential: credential.to_string(),
        }
    }

    #[test]
    fn device_sessions_are_scoped_to_the_active_profile() {
        let credential = "c".repeat(32);
        let current = session("work", &credential, 7);
        assert!(valid_agent_device_session(&current, "work"));
        assert!(!valid_agent_device_session(&current, "personal"));
    }

    #[test]
    fn device_session_rejects_malformed_credentials() {
        assert!(!valid_agent_device_session(
            &session("work", "short", 7),
            "work"
        ));
        assert!(!valid_agent_device_session(
            &session("work", &"c".repeat(32), 0),
            "work"
        ));
        assert!(!valid_agent_device_session(
            &session("work", &format!("{}\n", "c".repeat(31)), 7),
            "work"
        ));
    }
}
