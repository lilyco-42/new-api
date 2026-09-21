/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.
*/

//! The single execution boundary for local CLI tools.
//!
//! The webview submits an operation and typed parameters. It never submits an
//! executable, shell fragment, or arbitrary argv. Credentials are attached by
//! the desktop profile and are deliberately not model-visible.

use std::{
    collections::BTreeMap,
    io::{self, Read},
    path::PathBuf,
    process::{Child, Command, ExitStatus, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, RecvTimeoutError, Sender},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};

pub const MAX_CLI_ARGS: usize = 64;
pub const MAX_CLI_ARG_LENGTH: usize = 2048;
pub const MAX_CLI_OUTPUT_LENGTH: usize = 64 * 1024;
pub const DEFAULT_OPERATION_TIMEOUT: Duration = Duration::from_secs(30);

const SAFE_ENVIRONMENT: &[&str] = &[
    "PATH",
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "HOME",
    "LANG",
    "LC_ALL",
];

#[derive(Debug, Clone, Copy)]
pub struct CliToolSpec {
    pub id: &'static str,
    pub executable: &'static str,
    pub profile_scoped: bool,
}

/// The only place where the desktop binary grants executable access.
pub const CLI_TOOL_REGISTRY: &[CliToolSpec] = &[
    CliToolSpec {
        id: "gh",
        executable: "gh",
        profile_scoped: true,
    },
    CliToolSpec {
        id: "yazi",
        executable: "yazi",
        profile_scoped: false,
    },
    CliToolSpec {
        id: "jj",
        executable: "jj",
        profile_scoped: false,
    },
    CliToolSpec {
        id: "ast-grep",
        executable: "ast-grep",
        profile_scoped: false,
    },
    CliToolSpec {
        id: "codegraph",
        executable: "codegraph",
        profile_scoped: false,
    },
];

#[derive(Debug, Serialize)]
pub struct DeveloperToolStatus {
    pub id: String,
    pub installed: bool,
    pub version: Option<String>,
    pub message: Option<String>,
}

/// Compatibility request for the old Tauri command. `tool_id` and `args` are
/// intentionally gone: accepting them would restore the arbitrary-argv hole.
#[derive(Debug, Deserialize)]
pub struct CliExecRequest {
    pub operation: String,
    #[serde(default)]
    pub params: serde_json::Value,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct OperationRequest {
    pub operation: String,
    #[serde(default)]
    pub params: serde_json::Value,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

/// A profile is an identity boundary, not merely a `GH_CONFIG_DIR` string.
/// The complete OS keyring integration is a later component; until then the
/// runtime fails closed unless this validated profile binding is supplied.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ProfileCredentials {
    pub profile_id: String,
    pub gh_config_dir: PathBuf,
}

impl ProfileCredentials {
    pub fn new(profile_id: impl Into<String>, gh_config_dir: impl Into<PathBuf>) -> Self {
        Self {
            profile_id: profile_id.into(),
            gh_config_dir: gh_config_dir.into(),
        }
    }

    fn validate(&self) -> Result<(), String> {
        if !(1..=64).contains(&self.profile_id.len())
            || !self
                .profile_id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
        {
            return Err("Invalid desktop profile id.".to_string());
        }
        if !self.gh_config_dir.is_absolute() || !self.gh_config_dir.is_dir() {
            return Err("The desktop profile credential directory is unavailable.".to_string());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct CliExecResult {
    pub operation: String,
    pub tool_id: String,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub truncated: bool,
    pub status: ExecutionStatus,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionStatus {
    Succeeded,
    Failed,
    TimedOut,
    Cancelled,
    OutputLimit,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct IssueListParams {
    repo: String,
    #[serde(default = "default_issue_state")]
    state: String,
    #[serde(default = "default_issue_limit")]
    limit: u8,
    #[serde(default = "default_issue_sort")]
    sort: String,
}

fn default_issue_state() -> String {
    "open".to_string()
}
fn default_issue_limit() -> u8 {
    10
}
fn default_issue_sort() -> String {
    "updated".to_string()
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct RepositorySearchParams {
    query: String,
    #[serde(default = "default_issue_limit")]
    limit: u8,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct PullRequestListParams {
    repo: String,
    #[serde(default = "default_issue_state")]
    state: String,
    #[serde(default = "default_issue_limit")]
    limit: u8,
    #[serde(default = "default_issue_sort")]
    sort: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct EmptyParams {}

#[derive(Debug, Clone, Copy)]
struct OperationSpec {
    id: &'static str,
    tool_id: &'static str,
    read_only: bool,
}

const OPERATIONS: &[OperationSpec] = &[
    OperationSpec {
        id: "github.auth.status",
        tool_id: "gh",
        read_only: true,
    },
    OperationSpec {
        id: "github.issues.list",
        tool_id: "gh",
        read_only: true,
    },
    OperationSpec {
        id: "github.repositories.search",
        tool_id: "gh",
        read_only: true,
    },
    OperationSpec {
        id: "github.pull_requests.list",
        tool_id: "gh",
        read_only: true,
    },
];

pub fn cli_tool_spec(tool_id: &str) -> Result<&'static CliToolSpec, String> {
    CLI_TOOL_REGISTRY
        .iter()
        .find(|spec| spec.id == tool_id)
        .ok_or_else(|| format!("Unsupported CLI tool: {tool_id}"))
}

fn operation_spec(operation: &str) -> Result<&'static OperationSpec, String> {
    OPERATIONS
        .iter()
        .find(|spec| spec.id == operation)
        .ok_or_else(|| format!("Unsupported operation: {operation}"))
}

fn validate_cli_args(args: &[String]) -> Result<(), String> {
    if args.len() > MAX_CLI_ARGS {
        return Err(format!("Too many CLI arguments (maximum {MAX_CLI_ARGS})."));
    }
    if args
        .iter()
        .any(|arg| arg.len() > MAX_CLI_ARG_LENGTH || arg.contains('\0'))
    {
        return Err(format!("CLI arguments must be shorter than {MAX_CLI_ARG_LENGTH} characters and contain no NUL bytes."));
    }
    Ok(())
}

fn validate_repo(repo: &str) -> Result<(), String> {
    if repo.len() <= 200
        && repo.split('/').count() == 2
        && repo.split('/').all(|part| {
            !part.is_empty()
                && part
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        })
    {
        Ok(())
    } else {
        Err("Repository must look like owner/name.".to_string())
    }
}

fn validate_state(state: &str) -> Result<(), String> {
    if matches!(state, "open" | "closed" | "all") {
        Ok(())
    } else {
        Err("State must be open, closed, or all.".to_string())
    }
}

fn validate_sort(sort: &str) -> Result<(), String> {
    if matches!(sort, "updated" | "created") {
        Ok(())
    } else {
        Err("Sort must be updated or created.".to_string())
    }
}

fn validate_limit(limit: u8) -> Result<u8, String> {
    if (1..=50).contains(&limit) {
        Ok(limit)
    } else {
        Err("Limit must be between 1 and 50.".to_string())
    }
}

fn operation_args(request: &OperationRequest) -> Result<(OperationSpec, Vec<String>), String> {
    let spec = *operation_spec(request.operation.trim())?;
    debug_assert!(spec.read_only);
    let args: Vec<String> = match spec.id {
        "github.auth.status" => {
            let _: EmptyParams = serde_json::from_value(request.params.clone())
                .map_err(|_| "Invalid arguments for github.auth.status.".to_string())?;
            vec!["auth", "status", "--hostname", "github.com"]
                .into_iter()
                .map(str::to_string)
                .collect()
        }
        "github.issues.list" => {
            let params: IssueListParams = serde_json::from_value(request.params.clone())
                .map_err(|_| "Invalid arguments for github.issues.list.".to_string())?;
            validate_repo(params.repo.trim())?;
            validate_state(&params.state)?;
            validate_sort(&params.sort)?;
            vec![
                "issue",
                "list",
                "--repo",
                params.repo.trim(),
                "--state",
                &params.state,
                "--limit",
                &validate_limit(params.limit)?.to_string(),
                "--sort",
                &params.sort,
                "--json",
                "number,title,url,state,updatedAt,author",
            ]
            .into_iter()
            .map(str::to_string)
            .collect()
        }
        "github.repositories.search" => {
            let params: RepositorySearchParams = serde_json::from_value(request.params.clone())
                .map_err(|_| "Invalid arguments for github.repositories.search.".to_string())?;
            if params.query.trim().is_empty() || params.query.len() > 200 {
                return Err("Search text must contain 1–200 characters.".to_string());
            }
            let limit = validate_limit(params.limit)?.to_string();
            vec![
                "api",
                "search/repositories",
                "--method",
                "GET",
                "-f",
                &format!("q={}", params.query.trim()),
                "-f",
                &format!("per_page={limit}"),
                "-f",
                "sort=stars",
                "-f",
                "order=desc",
            ]
            .into_iter()
            .map(str::to_string)
            .collect()
        }
        "github.pull_requests.list" => {
            let params: PullRequestListParams = serde_json::from_value(request.params.clone())
                .map_err(|_| "Invalid arguments for github.pull_requests.list.".to_string())?;
            validate_repo(params.repo.trim())?;
            validate_state(&params.state)?;
            validate_sort(&params.sort)?;
            vec![
                "pr",
                "list",
                "--repo",
                params.repo.trim(),
                "--state",
                &params.state,
                "--limit",
                &validate_limit(params.limit)?.to_string(),
                "--sort",
                &params.sort,
                "--json",
                "number,title,url,state,updatedAt,author",
            ]
            .into_iter()
            .map(str::to_string)
            .collect()
        }
        _ => unreachable!(),
    };
    validate_cli_args(&args)?;
    Ok((spec, args))
}

#[derive(Debug, Clone)]
pub struct CancellationToken(Arc<AtomicBool>);

impl CancellationToken {
    pub fn new() -> Self {
        Self(Arc::new(AtomicBool::new(false)))
    }
    pub fn cancel(&self) {
        self.0.store(true, Ordering::Release);
    }
    fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
}
impl Default for CancellationToken {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone)]
struct ExecutionPolicy {
    timeout: Duration,
    output_limit: usize,
}

impl ExecutionPolicy {
    fn for_request(request: &OperationRequest) -> Result<Self, String> {
        let timeout = request
            .timeout_ms
            .map(Duration::from_millis)
            .unwrap_or(DEFAULT_OPERATION_TIMEOUT);
        if timeout.is_zero() || timeout > DEFAULT_OPERATION_TIMEOUT {
            return Err(format!(
                "Operation timeout must be between 1 and {} milliseconds.",
                DEFAULT_OPERATION_TIMEOUT.as_millis()
            ));
        }
        Ok(Self {
            timeout,
            output_limit: MAX_CLI_OUTPUT_LENGTH,
        })
    }
}

pub fn execute_operation(
    request: &OperationRequest,
    credentials: Option<&ProfileCredentials>,
    cancellation: &CancellationToken,
) -> Result<CliExecResult, String> {
    let (operation, args) = operation_args(request)?;
    let tool = cli_tool_spec(operation.tool_id)?;
    let credentials = if tool.profile_scoped {
        let credentials = credentials
            .ok_or_else(|| format!("Tool {} requires an explicit desktop profile.", tool.id))?;
        credentials.validate()?;
        Some(credentials)
    } else {
        None
    };
    let output = run_process(
        tool,
        &args,
        credentials,
        &ExecutionPolicy::for_request(request)?,
        cancellation,
    )?;
    Ok(CliExecResult {
        operation: operation.id.to_string(),
        tool_id: operation.tool_id.to_string(),
        exit_code: output.exit_code,
        stdout: output.stdout,
        stderr: output.stderr,
        truncated: output.truncated,
        status: output.status,
    })
}

/// Fixed `--version` is used for status probes; it does not expose operation input.
pub fn detect_cli_tool(
    tool_id: &str,
    credentials: Option<&ProfileCredentials>,
) -> DeveloperToolStatus {
    let result = cli_tool_spec(tool_id).and_then(|tool| {
        let credentials = if tool.profile_scoped {
            let c = credentials.ok_or_else(|| "Profile credentials are required.".to_string())?;
            c.validate()?;
            Some(c)
        } else {
            None
        };
        run_process(
            tool,
            &["--version".to_string()],
            credentials,
            &ExecutionPolicy {
                timeout: Duration::from_secs(5),
                output_limit: MAX_CLI_OUTPUT_LENGTH,
            },
            &CancellationToken::new(),
        )
    });
    match result {
        Ok(output) if matches!(output.status, ExecutionStatus::Succeeded) => {
            let version = output
                .stdout
                .lines()
                .chain(output.stderr.lines())
                .map(str::trim)
                .find(|line| !line.is_empty())
                .map(str::to_string);
            DeveloperToolStatus {
                id: tool_id.to_string(),
                installed: true,
                version,
                message: None,
            }
        }
        Ok(output) => DeveloperToolStatus {
            id: tool_id.to_string(),
            installed: false,
            version: None,
            message: Some(if output.stderr.is_empty() {
                format!("Execution status: {:?}", output.status)
            } else {
                output.stderr
            }),
        },
        Err(error) => DeveloperToolStatus {
            id: tool_id.to_string(),
            installed: false,
            version: None,
            message: Some(error),
        },
    }
}

#[derive(Debug)]
struct ProcessOutput {
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
    truncated: bool,
    status: ExecutionStatus,
}
#[derive(Debug, Clone, Copy)]
enum StreamKind {
    Stdout,
    Stderr,
}
#[derive(Debug)]
enum ReaderEvent {
    Data(StreamKind, Vec<u8>),
    End(StreamKind),
    Overflow,
    Error(String),
}

fn read_bounded<R: Read + Send + 'static>(
    mut reader: R,
    kind: StreamKind,
    tx: Sender<ReaderEvent>,
    limit: usize,
) {
    let mut buffer = [0_u8; 8192];
    let mut used = 0;
    let mut overflowed = false;
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => {
                let _ = tx.send(ReaderEvent::End(kind));
                break;
            }
            Ok(_size) if overflowed => continue,
            Ok(size) => {
                let remaining = limit.saturating_sub(used);
                if size > remaining {
                    if remaining > 0 {
                        let _ = tx.send(ReaderEvent::Data(kind, buffer[..remaining].to_vec()));
                    }
                    let _ = tx.send(ReaderEvent::Overflow);
                    overflowed = true;
                    used = limit;
                } else {
                    used += size;
                    let _ = tx.send(ReaderEvent::Data(kind, buffer[..size].to_vec()));
                }
            }
            Err(error) => {
                let _ = tx.send(ReaderEvent::Error(error.to_string()));
                break;
            }
        }
    }
}

fn clean_command_environment(command: &mut Command, credentials: Option<&ProfileCredentials>) {
    let inherited: BTreeMap<String, String> = std::env::vars()
        .filter(|(key, _)| {
            SAFE_ENVIRONMENT
                .iter()
                .any(|allowed| key.eq_ignore_ascii_case(allowed))
        })
        .collect();
    command.env_clear();
    command.envs(inherited);
    if let Some(credentials) = credentials {
        command.env("GH_CONFIG_DIR", &credentials.gh_config_dir);
    }
}

#[cfg(unix)]
fn configure_process_group(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    unsafe {
        command.pre_exec(|| {
            if libc::setpgid(0, 0) == -1 {
                Err(io::Error::last_os_error())
            } else {
                Ok(())
            }
        });
    }
}
#[cfg(not(unix))]
fn configure_process_group(_command: &mut Command) {}

#[cfg(windows)]
struct WindowsJob(windows_sys::Win32::Foundation::HANDLE);
#[cfg(windows)]
impl WindowsJob {
    fn create() -> Result<Self, String> {
        use windows_sys::Win32::System::JobObjects::CreateJobObjectW;
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            Err(format!(
                "Unable to create process job: {}",
                io::Error::last_os_error()
            ))
        } else {
            Ok(Self(handle))
        }
    }
    fn assign(&self, child: &Child) -> Result<(), String> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, JobObjectExtendedLimitInformation, SetInformationJobObject,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let info_ok = unsafe {
            SetInformationJobObject(
                self.0,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *mut _,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        let assign_ok = unsafe { AssignProcessToJobObject(self.0, child.as_raw_handle() as _) };
        if info_ok == 0 || assign_ok == 0 {
            Err(format!(
                "Unable to isolate child process tree: {}",
                io::Error::last_os_error()
            ))
        } else {
            Ok(())
        }
    }
    fn terminate(&self) {
        use windows_sys::Win32::System::JobObjects::TerminateJobObject;
        unsafe {
            TerminateJobObject(self.0, 1);
        }
    }
}
#[cfg(windows)]
impl Drop for WindowsJob {
    fn drop(&mut self) {
        use windows_sys::Win32::Foundation::CloseHandle;
        unsafe {
            CloseHandle(self.0);
        }
    }
}
#[cfg(windows)]
use std::os::windows::process::CommandExt;

fn run_process(
    tool: &CliToolSpec,
    args: &[String],
    credentials: Option<&ProfileCredentials>,
    policy: &ExecutionPolicy,
    cancellation: &CancellationToken,
) -> Result<ProcessOutput, String> {
    validate_cli_args(args)?;
    if tool.profile_scoped && credentials.is_none() {
        return Err(format!(
            "Tool {} requires an explicit desktop profile.",
            tool.id
        ));
    }
    let mut command = Command::new(tool.executable);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    clean_command_environment(&mut command, credentials);
    configure_process_group(&mut command);
    #[cfg(windows)]
    command.creation_flags(0x00000200);
    #[cfg(windows)]
    let job = WindowsJob::create()?;
    let mut child = command
        .spawn()
        .map_err(|error| format!("Unable to start {}: {error}", tool.id))?;
    #[cfg(windows)]
    job.assign(&child)?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Child stdout was not piped.".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Child stderr was not piped.".to_string())?;
    let (tx, rx) = mpsc::channel();
    let output_limit = policy.output_limit;
    let stdout_thread = thread::spawn({
        let tx = tx.clone();
        move || read_bounded(stdout, StreamKind::Stdout, tx, output_limit)
    });
    let stderr_thread = thread::spawn({
        let tx = tx.clone();
        move || read_bounded(stderr, StreamKind::Stderr, tx, output_limit)
    });
    drop(tx);
    let mut stdout_data = Vec::new();
    let mut stderr_data = Vec::new();
    let mut ended = [false, false];
    let mut termination = None;
    let started = Instant::now();
    let mut exit_status = None;
    loop {
        if termination.is_none() {
            if cancellation.is_cancelled() {
                kill_tree(
                    &mut child,
                    #[cfg(unix)]
                    child.id(),
                    #[cfg(windows)]
                    &job,
                );
                termination = Some(ExecutionStatus::Cancelled);
            } else if started.elapsed() >= policy.timeout {
                kill_tree(
                    &mut child,
                    #[cfg(unix)]
                    child.id(),
                    #[cfg(windows)]
                    &job,
                );
                termination = Some(ExecutionStatus::TimedOut);
            }
        }
        if exit_status.is_none() {
            if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
                exit_status = Some(status);
            }
        }
        match rx.recv_timeout(Duration::from_millis(20)) {
            Ok(ReaderEvent::Data(kind, bytes)) => match kind {
                StreamKind::Stdout => stdout_data.extend(bytes),
                StreamKind::Stderr => stderr_data.extend(bytes),
            },
            Ok(ReaderEvent::End(kind)) => {
                ended[match kind {
                    StreamKind::Stdout => 0,
                    StreamKind::Stderr => 1,
                }] = true
            }
            Ok(ReaderEvent::Overflow) => {
                if termination.is_none() {
                    kill_tree(
                        &mut child,
                        #[cfg(unix)]
                        child.id(),
                        #[cfg(windows)]
                        &job,
                    );
                    termination = Some(ExecutionStatus::OutputLimit);
                }
            }
            Ok(ReaderEvent::Error(error)) => {
                if termination.is_none() {
                    kill_tree(
                        &mut child,
                        #[cfg(unix)]
                        child.id(),
                        #[cfg(windows)]
                        &job,
                    );
                    termination = Some(ExecutionStatus::Failed);
                }
                stderr_data.extend(error.into_bytes());
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
        if exit_status.is_some() && ended == [true, true] {
            break;
        }
        if started.elapsed() > policy.timeout + Duration::from_secs(1) {
            if termination.is_none() {
                kill_tree(
                    &mut child,
                    #[cfg(unix)]
                    child.id(),
                    #[cfg(windows)]
                    &job,
                );
                termination = Some(ExecutionStatus::TimedOut);
            }
            break;
        }
    }
    let _ = child.wait();
    let _ = stdout_thread.join();
    let _ = stderr_thread.join();
    let status = termination.unwrap_or_else(|| {
        if exit_status
            .as_ref()
            .map(ExitStatus::success)
            .unwrap_or(false)
        {
            ExecutionStatus::Succeeded
        } else {
            ExecutionStatus::Failed
        }
    });
    Ok(ProcessOutput {
        exit_code: exit_status.and_then(|status| status.code()),
        stdout: String::from_utf8_lossy(&stdout_data).into_owned(),
        stderr: String::from_utf8_lossy(&stderr_data).into_owned(),
        truncated: matches!(status, ExecutionStatus::OutputLimit),
        status,
    })
}

#[cfg(unix)]
fn kill_tree(child: &mut Child, pid: u32) {
    unsafe {
        libc::kill(-(pid as i32), libc::SIGKILL);
    }
    let _ = child.kill();
}
#[cfg(windows)]
fn kill_tree(child: &mut Child, job: &WindowsJob) {
    job.terminate();
    let _ = child.kill();
}

pub fn bounded_text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(&bytes[..bytes.len().min(MAX_CLI_OUTPUT_LENGTH)]).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{collections::HashSet, fs, time::Duration};
    fn test_spec() -> CliToolSpec {
        #[cfg(windows)]
        {
            CliToolSpec {
                id: "test",
                executable: "powershell.exe",
                profile_scoped: false,
            }
        }
        #[cfg(not(windows))]
        {
            CliToolSpec {
                id: "test",
                executable: "sh",
                profile_scoped: false,
            }
        }
    }
    fn test_args(script: &str) -> Vec<String> {
        #[cfg(windows)]
        {
            vec![
                "-NoProfile".into(),
                "-NonInteractive".into(),
                "-Command".into(),
                script.into(),
            ]
        }
        #[cfg(not(windows))]
        {
            vec!["-c".into(), script.into()]
        }
    }
    fn output_script() -> &'static str {
        #[cfg(windows)]
        {
            "1..1000000 | % { 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' }"
        }
        #[cfg(not(windows))]
        {
            "yes xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
        }
    }
    fn hang_script() -> &'static str {
        #[cfg(windows)]
        {
            "Start-Sleep -Seconds 60"
        }
        #[cfg(not(windows))]
        {
            "sleep 60"
        }
    }
    #[test]
    fn cli_registry_has_unique_ids_and_safe_executables() {
        let mut ids = HashSet::new();
        for spec in CLI_TOOL_REGISTRY {
            assert!(!spec.id.is_empty());
            assert!(ids.insert(spec.id));
            assert!(!spec.executable.is_empty());
            assert!(spec
                .executable
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_')));
        }
        assert!(
            cli_tool_spec("gh")
                .expect("gh is registered")
                .profile_scoped
        );
    }
    #[test]
    fn readonly_operation_rejects_unknown_or_write_shaped_arguments() {
        let unknown = OperationRequest {
            operation: "gh.api".into(),
            params: serde_json::json!({"args":["repo","delete"]}),
            timeout_ms: None,
        };
        assert!(operation_args(&unknown).is_err());
        let malformed = OperationRequest {
            operation: "github.issues.list".into(),
            params: serde_json::json!({"repo":"owner/name","args":["--method","DELETE"]}),
            timeout_ms: None,
        };
        assert!(operation_args(&malformed).is_err());
        let forbidden_repo = OperationRequest {
            operation: "github.issues.list".into(),
            params: serde_json::json!({"repo":"owner/name --method DELETE"}),
            timeout_ms: None,
        };
        assert!(operation_args(&forbidden_repo).is_err());
    }
    #[test]
    fn profile_credentials_fail_closed_and_do_not_trust_environment_tokens() {
        let missing = ProfileCredentials::new("a", PathBuf::from("C:/does-not-exist"));
        assert!(missing.validate().is_err());
        let directory =
            std::env::temp_dir().join(format!("lain42-agent-test-{}", std::process::id()));
        let _ = fs::create_dir_all(&directory);
        let credentials = ProfileCredentials::new("profile-a", &directory);
        std::env::set_var("GH_TOKEN", "inherited-secret");
        let mut command = Command::new("echo");
        clean_command_environment(&mut command, Some(&credentials));
        let env = command.get_envs().collect::<Vec<_>>();
        assert!(!env.iter().any(|(key, value)| key
            .to_string_lossy()
            .eq_ignore_ascii_case("GH_TOKEN")
            && value.is_some()));
        assert!(env
            .iter()
            .any(|(key, _)| key.to_string_lossy() == "GH_CONFIG_DIR"));
        std::env::remove_var("GH_TOKEN");
        let _ = fs::remove_dir(&directory);
    }
    #[test]
    fn infinite_output_is_bounded_during_execution() {
        let output = run_process(
            &test_spec(),
            &test_args(output_script()),
            None,
            &ExecutionPolicy {
                timeout: Duration::from_secs(3),
                output_limit: 4096,
            },
            &CancellationToken::new(),
        )
        .expect("process result");
        assert!(matches!(output.status, ExecutionStatus::OutputLimit));
        assert!(output.stdout.len() <= 4096);
        assert!(output.truncated);
    }
    #[test]
    fn cancellation_terminates_a_hanging_process() {
        let token = CancellationToken::new();
        let cancellation = token.clone();
        let handle = thread::spawn(move || {
            run_process(
                &test_spec(),
                &test_args(hang_script()),
                None,
                &ExecutionPolicy {
                    timeout: Duration::from_secs(10),
                    output_limit: 4096,
                },
                &cancellation,
            )
            .expect("process result")
        });
        thread::sleep(Duration::from_millis(100));
        token.cancel();
        let output = handle.join().expect("join");
        assert!(matches!(output.status, ExecutionStatus::Cancelled));
    }
    #[test]
    fn bounded_text_preserves_the_transport_limit() {
        assert_eq!(
            bounded_text(&vec![b'a'; MAX_CLI_OUTPUT_LENGTH + 128]).len(),
            MAX_CLI_OUTPUT_LENGTH
        );
    }
}
