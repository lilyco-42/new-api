#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{env, fs, path::PathBuf};

use serde::Serialize;
use tauri::{webview::WebviewWindowBuilder, AppHandle, Manager, WebviewUrl};
use url::Url;

mod tool_runtime;

use tool_runtime::{
    bounded_text, cli_output, cli_tool_spec, detect_cli_tool, CliExecRequest, CliExecResult,
    DeveloperToolStatus, CLI_TOOL_REGISTRY,
};

const DEFAULT_AGENT_URL: &str = "https://api.lain42.top/agent";

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
    ids.into_iter()
        .filter_map(|id| cli_tool_spec(&id).ok())
        .map(|spec| {
            let profile_dir = spec
                .profile_scoped
                .then(|| gh_config_dir(&app).ok())
                .flatten();
            detect_cli_tool(spec.id, profile_dir.as_deref())
        })
        .collect()
}

#[tauri::command]
fn cli_exec(app: AppHandle, request: CliExecRequest) -> Result<CliExecResult, String> {
    let tool_id = request.tool_id.trim().to_string();
    let spec = cli_tool_spec(&tool_id)?;
    let profile_dir = spec
        .profile_scoped
        .then(|| gh_config_dir(&app))
        .transpose()?;
    let output = cli_output(&tool_id, &request.args, profile_dir.as_deref())?;
    Ok(CliExecResult {
        tool_id,
        exit_code: output.status.code(),
        stdout: bounded_text(&output.stdout),
        stderr: bounded_text(&output.stderr),
    })
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

fn gh_output(app: &AppHandle, args: &[&str]) -> Result<std::process::Output, String> {
    let args = args
        .iter()
        .map(|argument| (*argument).to_string())
        .collect::<Vec<_>>();
    let profile_dir = gh_config_dir(app)?;
    cli_output("gh", &args, Some(&profile_dir))
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
    let output = match gh_output(&app, &["auth", "status", "--hostname", "github.com"]) {
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

    let text = String::from_utf8_lossy(&output.stdout);
    let error_text = String::from_utf8_lossy(&output.stderr);
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
        authenticated: output.status.success(),
        account,
        message: if output.status.success() {
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
    let limit_value = limit.to_string();
    let query_arg = format!("q={query}");
    let page_arg = format!("per_page={limit_value}");
    let output = gh_output(
        &app,
        &[
            "api",
            "search/repositories",
            "--method",
            "GET",
            "-f",
            &query_arg,
            "-f",
            &page_arg,
            "-f",
            "sort=stars",
            "-f",
            "order=desc",
        ],
    )?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("Invalid GitHub response: {error}"))
}

#[tauri::command]
fn gh_list_issues(app: AppHandle, repo: String, limit: u8) -> Result<serde_json::Value, String> {
    validate_repo(repo.trim())?;
    let limit = validate_limit(limit)?.to_string();
    let output = gh_output(
        &app,
        &[
            "issue",
            "list",
            "--repo",
            repo.trim(),
            "--state",
            "all",
            "--limit",
            &limit,
            "--json",
            "number,title,url,state,updatedAt,author",
        ],
    )?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("Invalid GitHub response: {error}"))
}

#[tauri::command]
fn gh_list_pull_requests(
    app: AppHandle,
    repo: String,
    limit: u8,
) -> Result<serde_json::Value, String> {
    validate_repo(repo.trim())?;
    let limit = validate_limit(limit)?.to_string();
    let output = gh_output(
        &app,
        &[
            "pr",
            "list",
            "--repo",
            repo.trim(),
            "--state",
            "all",
            "--limit",
            &limit,
            "--json",
            "number,title,url,state,updatedAt,author",
        ],
    )?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("Invalid GitHub response: {error}"))
}

fn main() {
    tauri::Builder::default()
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
            cli_exec
        ])
        .run(tauri::generate_context!())
        .expect("error while running Lain42 Agent");
}
