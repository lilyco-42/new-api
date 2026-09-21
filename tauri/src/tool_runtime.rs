/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/

use std::{path::Path, process::Command};

use serde::{Deserialize, Serialize};

pub const MAX_CLI_ARGS: usize = 64;
pub const MAX_CLI_ARG_LENGTH: usize = 2048;
pub const MAX_CLI_OUTPUT_LENGTH: usize = 64 * 1024;

#[derive(Debug, Clone, Copy)]
pub struct CliToolSpec {
    pub id: &'static str,
    pub executable: &'static str,
    pub profile_scoped: bool,
}

/// The only place where the desktop binary grants executable access.
///
/// Keep this list deliberately static: the webview can select a stable id but
/// can never provide an executable path or shell fragment. A future MCP
/// adapter should have a separate registry and transport boundary.
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

#[derive(Debug, Deserialize)]
pub struct CliExecRequest {
    pub tool_id: String,
    pub args: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct CliExecResult {
    pub tool_id: String,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

pub fn cli_tool_spec(tool_id: &str) -> Result<&'static CliToolSpec, String> {
    CLI_TOOL_REGISTRY
        .iter()
        .find(|spec| spec.id == tool_id)
        .ok_or_else(|| format!("Unsupported CLI tool: {tool_id}"))
}

pub fn validate_cli_args(args: &[String]) -> Result<(), String> {
    if args.len() > MAX_CLI_ARGS {
        return Err(format!("Too many CLI arguments (maximum {MAX_CLI_ARGS})."));
    }
    if args
        .iter()
        .any(|argument| argument.len() > MAX_CLI_ARG_LENGTH || argument.contains('\0'))
    {
        return Err(format!(
            "CLI arguments must be shorter than {MAX_CLI_ARG_LENGTH} characters and contain no NUL bytes."
        ));
    }
    Ok(())
}

pub fn cli_output(
    tool_id: &str,
    args: &[String],
    profile_dir: Option<&Path>,
) -> Result<std::process::Output, String> {
    validate_cli_args(args)?;
    let spec = cli_tool_spec(tool_id)?;
    let mut command = Command::new(spec.executable);
    command.args(args);
    if spec.profile_scoped {
        let profile_dir = profile_dir.ok_or_else(|| {
            format!("Tool {tool_id} requires a desktop profile before it can run.")
        })?;
        command.env("GH_CONFIG_DIR", profile_dir);
    }
    command
        .output()
        .map_err(|error| format!("Unable to start {tool_id}: {error}"))
}

pub fn bounded_text(bytes: &[u8]) -> String {
    let end = bytes.len().min(MAX_CLI_OUTPUT_LENGTH);
    String::from_utf8_lossy(&bytes[..end]).to_string()
}

pub fn detect_cli_tool(tool_id: &str, profile_dir: Option<&Path>) -> DeveloperToolStatus {
    let args = vec!["--version".to_string()];
    match cli_output(tool_id, &args, profile_dir) {
        Ok(output) if output.status.success() => {
            let text = bounded_text(&output.stdout);
            let error_text = bounded_text(&output.stderr);
            let version = text
                .lines()
                .chain(error_text.lines())
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
            message: Some(bounded_text(&output.stderr).trim().to_string()),
        },
        Err(error) => DeveloperToolStatus {
            id: tool_id.to_string(),
            installed: false,
            version: None,
            message: Some(error),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn cli_registry_has_unique_ids_and_safe_executables() {
        let mut ids = HashSet::new();

        for spec in CLI_TOOL_REGISTRY {
            assert!(!spec.id.is_empty());
            assert!(ids.insert(spec.id));
            assert!(!spec.executable.is_empty());
            assert!(spec.executable.chars().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '-' | '_')
            }));
        }

        let gh = cli_tool_spec("gh").expect("gh is part of the stable registry");
        assert!(gh.profile_scoped);
    }

    #[test]
    fn cli_argument_validation_enforces_the_transport_budget() {
        assert!(validate_cli_args(&[]).is_ok());
        assert!(validate_cli_args(&["ok".to_string()]).is_ok());
        assert!(validate_cli_args(&["x".repeat(MAX_CLI_ARG_LENGTH)]).is_ok());
        assert!(validate_cli_args(&["x".repeat(MAX_CLI_ARG_LENGTH + 1)]).is_err());
        assert!(validate_cli_args(&["contains\0nul".to_string()]).is_err());
        assert!(validate_cli_args(
            &(0..=MAX_CLI_ARGS)
                .map(|_| "arg".to_string())
                .collect::<Vec<_>>()
        )
        .is_err());
    }

    #[test]
    fn cli_output_is_bounded_before_crossing_the_webview_boundary() {
        let output = bounded_text(&vec![b'a'; MAX_CLI_OUTPUT_LENGTH + 128]);
        assert_eq!(output.len(), MAX_CLI_OUTPUT_LENGTH);
    }

    #[test]
    fn profile_scoped_cli_requires_a_profile_directory() {
        let error = cli_output("gh", &[], None).expect_err("gh must be isolated");
        assert!(error.contains("requires a desktop profile"));
    }
}
