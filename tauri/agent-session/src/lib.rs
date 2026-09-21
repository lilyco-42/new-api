//! A small, Tauri-independent OpenAI-compatible model/tool session.
//!
//! The loop only executes structured `assistant.tool_calls`. It never treats
//! prose, markdown, or a `Tool:` line as an instruction. Tool policy and
//! execution are supplied by the caller (P0-A); this crate does not contain a
//! second CLI/MCP executor.

use std::{
    collections::HashSet,
    fmt,
    future::Future,
    pin::Pin,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::Notify;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// OpenAI chat message roles. The `tool` role is always paired with a call id.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    System,
    User,
    Assistant,
    Tool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ChatMessage {
    pub role: Role,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<AssistantToolCall>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
}

impl ChatMessage {
    pub fn user(content: impl Into<String>) -> Self {
        Self {
            role: Role::User,
            content: Some(content.into()),
            name: None,
            tool_calls: None,
            tool_call_id: None,
        }
    }

    pub fn assistant(content: Option<String>, tool_calls: Option<Vec<AssistantToolCall>>) -> Self {
        Self {
            role: Role::Assistant,
            content,
            name: None,
            tool_calls,
            tool_call_id: None,
        }
    }

    pub fn tool(call_id: impl Into<String>, content: impl Into<String>) -> Self {
        Self {
            role: Role::Tool,
            content: Some(content.into()),
            name: None,
            tool_calls: None,
            tool_call_id: Some(call_id.into()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AssistantToolCall {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub function: FunctionCall,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FunctionCall {
    pub name: String,
    /// OpenAI sends arguments as a JSON string. Parsing is deliberately done
    /// by the loop only after a complete model response is received.
    pub arguments: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FunctionDefinition {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub parameters: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ToolDefinition {
    #[serde(rename = "type")]
    pub kind: String,
    pub function: FunctionDefinition,
}

impl ToolDefinition {
    pub fn function(
        name: impl Into<String>,
        description: Option<String>,
        parameters: Value,
    ) -> Self {
        Self {
            kind: "function".to_owned(),
            function: FunctionDefinition {
                name: name.into(),
                description,
                parameters,
            },
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ChatRequest {
    pub model: String,
    pub messages: Vec<ChatMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<ToolDefinition>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_choice: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AssistantResponse {
    pub message: ChatMessage,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ToolInvocation {
    pub run_id: String,
    pub call_id: String,
    pub tool_name: String,
    pub arguments: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ToolResult {
    pub call_id: String,
    pub status: ToolResultStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub structured_content: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ToolResultStatus {
    Success,
    Error,
}

impl ToolResult {
    pub fn success(
        call_id: impl Into<String>,
        structured_content: Option<Value>,
        text: Option<String>,
    ) -> Self {
        Self {
            call_id: call_id.into(),
            status: ToolResultStatus::Success,
            structured_content,
            text,
            error_code: None,
        }
    }

    pub fn error(
        call_id: impl Into<String>,
        code: impl Into<String>,
        text: impl Into<String>,
    ) -> Self {
        Self {
            call_id: call_id.into(),
            status: ToolResultStatus::Error,
            structured_content: None,
            text: Some(text.into()),
            error_code: Some(code.into()),
        }
    }

    fn message_content(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| {
            "{\"status\":\"error\",\"error_code\":\"serialization_error\"}".to_owned()
        })
    }
}

#[derive(Debug, Clone)]
pub struct LoopConfig {
    /// Model identifier sent to transports that use the request as-is. The
    /// HTTP adapter uses its own configured model, allowing local/BYOK/platform
    /// endpoints to select independently.
    pub model: String,
    /// Number of model responses (including the first response).
    pub max_steps: usize,
    /// Number of tool calls across the complete run.
    pub max_tool_calls: usize,
}

impl Default for LoopConfig {
    fn default() -> Self {
        Self {
            model: "agent".to_owned(),
            max_steps: 8,
            max_tool_calls: 8,
        }
    }
}

/// Cancellation shared with the model transport and P0-A executor.
#[derive(Clone, Default)]
pub struct CancellationToken {
    state: Arc<CancelState>,
}

#[derive(Default)]
struct CancelState {
    cancelled: AtomicBool,
    notify: Notify,
}

impl fmt::Debug for CancellationToken {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CancellationToken")
            .field("cancelled", &self.is_cancelled())
            .finish()
    }
}

impl CancellationToken {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.state.cancelled.store(true, Ordering::Release);
        self.state.notify.notify_waiters();
    }

    pub fn is_cancelled(&self) -> bool {
        self.state.cancelled.load(Ordering::Acquire)
    }

    pub async fn cancelled(&self) {
        loop {
            // Register the waiter before checking the flag so a cancel that
            // races with this method cannot be lost between the two actions.
            let notified = self.state.notify.notified();
            if self.is_cancelled() {
                return;
            }
            notified.await;
        }
    }
}

pub trait ModelTransport: Send + Sync {
    fn complete<'a>(
        &'a self,
        request: &'a ChatRequest,
        cancel: &'a CancellationToken,
    ) -> BoxFuture<'a, Result<AssistantResponse, ModelError>>;
}

pub trait ToolPolicy: Send + Sync {
    fn definitions(&self) -> Vec<ToolDefinition>;
    /// Validate allowlist, schema, and any run-specific authorization. This
    /// must not invoke the tool.
    fn validate(&self, tool_name: &str, arguments: &Value) -> Result<(), ToolPolicyError>;
}

pub trait ToolExecutor: Send + Sync {
    fn execute<'a>(
        &'a self,
        invocation: ToolInvocation,
        cancel: &'a CancellationToken,
    ) -> BoxFuture<'a, Result<ToolResult, ToolExecutionError>>;
}

pub trait EventSink: Send + Sync {
    fn emit(&self, event: RunEvent);
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum RunEvent {
    Started {
        run_id: String,
    },
    ModelResponse {
        run_id: String,
        step: usize,
    },
    ToolRequested {
        run_id: String,
        call_id: String,
        tool_name: String,
    },
    ToolRunning {
        run_id: String,
        call_id: String,
        tool_name: String,
    },
    ToolResult {
        run_id: String,
        result: ToolResult,
    },
    AssistantFinal {
        run_id: String,
        message: ChatMessage,
    },
    Failed {
        run_id: String,
        error: String,
    },
    Cancelled {
        run_id: String,
    },
}

#[derive(Debug, Clone)]
pub struct RunOutcome {
    pub run_id: String,
    pub final_message: ChatMessage,
    /// Full history, including every assistant tool-call message and paired
    /// `role=tool` message, for a caller that persists/replays the run.
    pub messages: Vec<ChatMessage>,
    pub steps: usize,
    pub tool_calls: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ModelError {
    Http {
        status: Option<u16>,
        message: String,
    },
    InvalidResponse(String),
    ResponseTooLarge {
        limit: usize,
    },
    Timeout,
    Cancelled,
}

impl fmt::Display for ModelError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Http { status, message } => write!(f, "model HTTP error ({status:?}): {message}"),
            Self::InvalidResponse(e) => write!(f, "invalid model response: {e}"),
            Self::ResponseTooLarge { limit } => write!(f, "model response exceeds {limit} bytes"),
            Self::Timeout => f.write_str("model request timed out"),
            Self::Cancelled => f.write_str("model request cancelled"),
        }
    }
}

impl std::error::Error for ModelError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToolPolicyError {
    UnknownTool,
    InvalidArguments(String),
    PermissionDenied(String),
}

impl fmt::Display for ToolPolicyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnknownTool => f.write_str("unknown tool"),
            Self::InvalidArguments(e) => write!(f, "invalid arguments: {e}"),
            Self::PermissionDenied(e) => write!(f, "permission denied: {e}"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolExecutionError {
    pub code: String,
    pub message: String,
}

impl ToolExecutionError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LoopError {
    Model(ModelError),
    InvalidModelToolCall(String),
    DuplicateCallId(String),
    BudgetExceeded {
        max_steps: usize,
        max_tool_calls: usize,
    },
    Cancelled,
}

impl fmt::Display for LoopError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Model(e) => e.fmt(f),
            Self::InvalidModelToolCall(e) => write!(f, "invalid model tool call: {e}"),
            Self::DuplicateCallId(id) => write!(f, "duplicate tool call id: {id}"),
            Self::BudgetExceeded {
                max_steps,
                max_tool_calls,
            } => write!(
                f,
                "agent budget exceeded (steps={max_steps}, tool_calls={max_tool_calls})"
            ),
            Self::Cancelled => f.write_str("run cancelled"),
        }
    }
}

impl std::error::Error for LoopError {}

pub struct AgentLoop<M, P, X> {
    pub model: M,
    pub policy: P,
    pub executor: X,
    pub config: LoopConfig,
}

impl<M, P, X> AgentLoop<M, P, X>
where
    M: ModelTransport,
    P: ToolPolicy,
    X: ToolExecutor,
{
    pub async fn run<S: EventSink>(
        &self,
        run_id: impl Into<String>,
        initial_messages: Vec<ChatMessage>,
        sink: &S,
        cancel: &CancellationToken,
    ) -> Result<RunOutcome, LoopError> {
        let run_id = run_id.into();
        sink.emit(RunEvent::Started {
            run_id: run_id.clone(),
        });
        let mut messages = initial_messages;
        let mut seen_ids = HashSet::new();
        let mut steps = 0;
        let mut tool_calls = 0;
        loop {
            if cancel.is_cancelled() {
                sink.emit(RunEvent::Cancelled {
                    run_id: run_id.clone(),
                });
                return Err(LoopError::Cancelled);
            }
            if steps >= self.config.max_steps {
                return self.fail(
                    sink,
                    &run_id,
                    LoopError::BudgetExceeded {
                        max_steps: self.config.max_steps,
                        max_tool_calls: self.config.max_tool_calls,
                    },
                );
            }
            let request = ChatRequest {
                model: self.config.model.clone(),
                messages: messages.clone(),
                tools: Some(self.policy.definitions()),
                tool_choice: None,
            };
            let response = tokio::select! { _ = cancel.cancelled() => { sink.emit(RunEvent::Cancelled { run_id: run_id.clone() }); return Err(LoopError::Cancelled); }, response = self.model.complete(&request, cancel) => response.map_err(LoopError::Model)? };
            steps += 1;
            sink.emit(RunEvent::ModelResponse {
                run_id: run_id.clone(),
                step: steps,
            });
            let assistant = response.message;
            let calls = assistant.tool_calls.clone().unwrap_or_default();
            messages.push(assistant.clone());
            if calls.is_empty() {
                sink.emit(RunEvent::AssistantFinal {
                    run_id: run_id.clone(),
                    message: assistant.clone(),
                });
                return Ok(RunOutcome {
                    run_id,
                    final_message: assistant,
                    messages,
                    steps,
                    tool_calls,
                });
            }
            for call in calls {
                if call.id.is_empty() {
                    return self.fail(
                        sink,
                        &run_id,
                        LoopError::InvalidModelToolCall("tool call id is empty".to_owned()),
                    );
                }
                if !seen_ids.insert(call.id.clone()) {
                    return self.fail(sink, &run_id, LoopError::DuplicateCallId(call.id));
                }
                if call.kind != "function" || call.function.name.is_empty() {
                    return self.fail(
                        sink,
                        &run_id,
                        LoopError::InvalidModelToolCall(
                            "only function tool calls with a name are supported".to_owned(),
                        ),
                    );
                }
                if tool_calls >= self.config.max_tool_calls {
                    return self.fail(
                        sink,
                        &run_id,
                        LoopError::BudgetExceeded {
                            max_steps: self.config.max_steps,
                            max_tool_calls: self.config.max_tool_calls,
                        },
                    );
                }
                tool_calls += 1;
                sink.emit(RunEvent::ToolRequested {
                    run_id: run_id.clone(),
                    call_id: call.id.clone(),
                    tool_name: call.function.name.clone(),
                });
                let result = match serde_json::from_str::<Value>(&call.function.arguments) {
                    Ok(arguments) => match self.policy.validate(&call.function.name, &arguments) {
                        Ok(()) => {
                            sink.emit(RunEvent::ToolRunning {
                                run_id: run_id.clone(),
                                call_id: call.id.clone(),
                                tool_name: call.function.name.clone(),
                            });
                            let invocation = ToolInvocation {
                                run_id: run_id.clone(),
                                call_id: call.id.clone(),
                                tool_name: call.function.name.clone(),
                                arguments,
                            };
                            match tokio::select! { _ = cancel.cancelled() => { sink.emit(RunEvent::Cancelled { run_id: run_id.clone() }); return Err(LoopError::Cancelled); }, result = self.executor.execute(invocation, cancel) => result }
                            {
                                Ok(result) => result,
                                Err(error) => {
                                    ToolResult::error(call.id.clone(), error.code, error.message)
                                }
                            }
                        }
                        Err(error) => ToolResult::error(
                            call.id.clone(),
                            "invalid_arguments",
                            error.to_string(),
                        ),
                    },
                    Err(error) => ToolResult::error(
                        call.id.clone(),
                        "invalid_arguments",
                        format!("arguments are not valid JSON: {error}"),
                    ),
                };
                sink.emit(RunEvent::ToolResult {
                    run_id: run_id.clone(),
                    result: result.clone(),
                });
                messages.push(ChatMessage::tool(
                    result.call_id.clone(),
                    result.message_content(),
                ));
            }
        }
    }

    fn fail<S: EventSink>(
        &self,
        sink: &S,
        run_id: &str,
        error: LoopError,
    ) -> Result<RunOutcome, LoopError> {
        sink.emit(RunEvent::Failed {
            run_id: run_id.to_owned(),
            error: error.to_string(),
        });
        Err(error)
    }
}

/// HTTP configuration. `api_key` deliberately has no Debug implementation
/// and is only converted to an Authorization header at request time.
#[derive(Clone)]
pub struct HttpModelConfig {
    pub endpoint: String,
    pub api_key: Option<String>,
    pub model: String,
    pub timeout: Duration,
    pub max_response_bytes: usize,
}

impl fmt::Debug for HttpModelConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("HttpModelConfig")
            .field("endpoint", &self.endpoint)
            .field("api_key", &self.api_key.as_ref().map(|_| "[redacted]"))
            .field("model", &self.model)
            .field("timeout", &self.timeout)
            .field("max_response_bytes", &self.max_response_bytes)
            .finish()
    }
}

#[derive(Clone, Debug)]
pub struct HttpModel {
    client: reqwest::Client,
    config: HttpModelConfig,
}

impl HttpModel {
    pub fn new(config: HttpModelConfig) -> Result<Self, ModelError> {
        let client = reqwest::Client::builder()
            .timeout(config.timeout)
            .build()
            .map_err(|e| ModelError::Http {
                status: None,
                message: e.to_string(),
            })?;
        Ok(Self { client, config })
    }
}

impl ModelTransport for HttpModel {
    fn complete<'a>(
        &'a self,
        request: &'a ChatRequest,
        cancel: &'a CancellationToken,
    ) -> BoxFuture<'a, Result<AssistantResponse, ModelError>> {
        Box::pin(async move {
            let mut request = request.clone();
            request.model = self.config.model.clone();
            let mut builder = self.client.post(&self.config.endpoint).json(&request);
            if let Some(key) = &self.config.api_key {
                builder = builder.bearer_auth(key);
            }
            let response = tokio::select! { _ = cancel.cancelled() => return Err(ModelError::Cancelled), response = builder.send() => response.map_err(|e| if e.is_timeout() { ModelError::Timeout } else { ModelError::Http { status: e.status().map(|s| s.as_u16()), message: e.to_string() } })? };
            let status = response.status();
            if response
                .content_length()
                .is_some_and(|length| length > self.config.max_response_bytes as u64)
            {
                return Err(ModelError::ResponseTooLarge {
                    limit: self.config.max_response_bytes,
                });
            }
            let mut bytes = Vec::new();
            let mut response = response;
            while let Some(chunk) = tokio::select! {
                _ = cancel.cancelled() => return Err(ModelError::Cancelled),
                chunk = response.chunk() => chunk.map_err(|e| ModelError::Http { status: Some(status.as_u16()), message: e.to_string() })?,
            } {
                if bytes.len().saturating_add(chunk.len()) > self.config.max_response_bytes {
                    return Err(ModelError::ResponseTooLarge {
                        limit: self.config.max_response_bytes,
                    });
                }
                bytes.extend_from_slice(&chunk);
            }
            if !status.is_success() {
                return Err(ModelError::Http {
                    status: Some(status.as_u16()),
                    message: String::from_utf8_lossy(&bytes).into_owned(),
                });
            }
            #[derive(Deserialize)]
            struct Envelope {
                choices: Vec<Choice>,
            }
            #[derive(Deserialize)]
            struct Choice {
                message: ChatMessage,
            }
            let envelope: Envelope = serde_json::from_slice(&bytes)
                .map_err(|e| ModelError::InvalidResponse(e.to_string()))?;
            let choice =
                envelope.choices.into_iter().next().ok_or_else(|| {
                    ModelError::InvalidResponse("response has no choices".to_owned())
                })?;
            Ok(AssistantResponse {
                message: choice.message,
                usage: None,
                request_id: None,
            })
        })
    }
}

// Streaming is intentionally not advertised: this adapter makes one bounded,
// non-streaming request. Streaming tool-call aggregation remains a follow-up.

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    #[derive(Default)]
    struct Events(Mutex<Vec<RunEvent>>);
    impl EventSink for Events {
        fn emit(&self, event: RunEvent) {
            self.0.lock().unwrap().push(event);
        }
    }
    struct Policy;
    impl ToolPolicy for Policy {
        fn definitions(&self) -> Vec<ToolDefinition> {
            vec![ToolDefinition::function(
                "echo",
                None,
                serde_json::json!({"type":"object"}),
            )]
        }
        fn validate(&self, name: &str, args: &Value) -> Result<(), ToolPolicyError> {
            if name != "echo" {
                return Err(ToolPolicyError::UnknownTool);
            }
            if !args.is_object() {
                return Err(ToolPolicyError::InvalidArguments("object required".into()));
            }
            Ok(())
        }
    }
    struct Model {
        responses: Mutex<Vec<AssistantResponse>>,
    }
    impl ModelTransport for Model {
        fn complete<'a>(
            &'a self,
            _r: &'a ChatRequest,
            _c: &'a CancellationToken,
        ) -> BoxFuture<'a, Result<AssistantResponse, ModelError>> {
            Box::pin(async { Ok(self.responses.lock().unwrap().remove(0)) })
        }
    }
    struct Exec(Arc<Mutex<Vec<ToolInvocation>>>);
    impl ToolExecutor for Exec {
        fn execute<'a>(
            &'a self,
            i: ToolInvocation,
            _c: &'a CancellationToken,
        ) -> BoxFuture<'a, Result<ToolResult, ToolExecutionError>> {
            self.0.lock().unwrap().push(i.clone());
            Box::pin(async move {
                Ok(ToolResult::success(
                    i.call_id,
                    Some(serde_json::json!({"ok":true})),
                    None,
                ))
            })
        }
    }
    fn call(id: &str, name: &str, args: &str) -> AssistantToolCall {
        AssistantToolCall {
            id: id.into(),
            kind: "function".into(),
            function: FunctionCall {
                name: name.into(),
                arguments: args.into(),
            },
        }
    }
    fn response(calls: Vec<AssistantToolCall>) -> AssistantResponse {
        AssistantResponse {
            message: ChatMessage::assistant(None, Some(calls)),
            usage: None,
            request_id: None,
        }
    }
    #[tokio::test]
    async fn structured_call_result_continues_and_preserves_ids() {
        let exec = Arc::new(Mutex::new(vec![]));
        let model = Model {
            responses: Mutex::new(vec![
                response(vec![call("a", "echo", "{}"), call("b", "echo", "{}")]),
                AssistantResponse {
                    message: ChatMessage::assistant(Some("done".into()), None),
                    usage: None,
                    request_id: None,
                },
            ]),
        };
        let loop_ = AgentLoop {
            model,
            policy: Policy,
            executor: Exec(exec.clone()),
            config: LoopConfig::default(),
        };
        let events = Events::default();
        let out = loop_
            .run(
                "r1",
                vec![ChatMessage::user("go")],
                &events,
                &CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(out.final_message.content.as_deref(), Some("done"));
        assert_eq!(out.tool_calls, 2);
        assert_eq!(
            exec.lock()
                .unwrap()
                .iter()
                .map(|x| x.call_id.as_str())
                .collect::<Vec<_>>(),
            vec!["a", "b"]
        );
        assert!(matches!(out.messages[2].role, Role::Tool));
        assert_eq!(out.messages[2].tool_call_id.as_deref(), Some("a"));
    }
    #[tokio::test]
    async fn invalid_args_are_structured_tool_error_without_execution() {
        let exec = Arc::new(Mutex::new(vec![]));
        let model = Model {
            responses: Mutex::new(vec![
                response(vec![call("a", "echo", "not-json")]),
                AssistantResponse {
                    message: ChatMessage::assistant(Some("recovered".into()), None),
                    usage: None,
                    request_id: None,
                },
            ]),
        };
        let loop_ = AgentLoop {
            model,
            policy: Policy,
            executor: Exec(exec.clone()),
            config: LoopConfig::default(),
        };
        let out = loop_
            .run(
                "r",
                vec![ChatMessage::user("x")],
                &Events::default(),
                &CancellationToken::new(),
            )
            .await
            .unwrap();
        assert!(exec.lock().unwrap().is_empty());
        assert!(out
            .messages
            .iter()
            .any(|m| m.role == Role::Tool
                && m.content.as_ref().unwrap().contains("invalid_arguments")));
    }
    #[tokio::test]
    async fn duplicate_id_and_budget_are_rejected() {
        let model = Model {
            responses: Mutex::new(vec![
                response(vec![call("a", "echo", "{}")]),
                response(vec![call("a", "echo", "{}")]),
            ]),
        };
        let loop_ = AgentLoop {
            model,
            policy: Policy,
            executor: Exec(Arc::new(Mutex::new(vec![]))),
            config: LoopConfig::default(),
        };
        let e = loop_
            .run(
                "r",
                vec![ChatMessage::user("x")],
                &Events::default(),
                &CancellationToken::new(),
            )
            .await
            .unwrap_err();
        assert_eq!(e, LoopError::DuplicateCallId("a".into()));
        let model = Model {
            responses: Mutex::new(vec![response(vec![call("a", "echo", "{}")])]),
        };
        let loop_ = AgentLoop {
            model,
            policy: Policy,
            executor: Exec(Arc::new(Mutex::new(vec![]))),
            config: LoopConfig {
                model: "test".into(),
                max_steps: 8,
                max_tool_calls: 0,
            },
        };
        assert!(matches!(
            loop_
                .run(
                    "r",
                    vec![ChatMessage::user("x")],
                    &Events::default(),
                    &CancellationToken::new()
                )
                .await,
            Err(LoopError::BudgetExceeded { .. })
        ));
    }
    #[tokio::test]
    async fn cancellation_is_terminal() {
        let token = CancellationToken::new();
        token.cancel();
        let model = Model {
            responses: Mutex::new(vec![]),
        };
        let loop_ = AgentLoop {
            model,
            policy: Policy,
            executor: Exec(Arc::new(Mutex::new(vec![]))),
            config: LoopConfig::default(),
        };
        assert_eq!(
            loop_
                .run(
                    "r",
                    vec![ChatMessage::user("x")],
                    &Events::default(),
                    &token
                )
                .await
                .unwrap_err(),
            LoopError::Cancelled
        );
    }

    async fn test_http_server(status: &str, body: &[u8]) -> String {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let status = status.to_owned();
        let body = body.to_vec();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 4096];
            let _ = socket.read(&mut request).await;
            let header = format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
            socket.write_all(header.as_bytes()).await.unwrap();
            socket.write_all(&body).await.unwrap();
        });
        format!("http://{address}/v1/chat/completions")
    }

    #[tokio::test]
    async fn http_adapter_surfaces_status_and_bounds_body_without_logging_secret() {
        let endpoint =
            test_http_server("500 Internal Server Error", br#"{"error":"upstream"}"#).await;
        let model = HttpModel::new(HttpModelConfig {
            endpoint,
            api_key: Some("secret-must-not-be-debugged".into()),
            model: "local".into(),
            timeout: Duration::from_secs(2),
            max_response_bytes: 1024,
        })
        .unwrap();
        let error = model
            .complete(
                &ChatRequest {
                    model: "caller".into(),
                    messages: vec![],
                    tools: None,
                    tool_choice: None,
                },
                &CancellationToken::new(),
            )
            .await
            .unwrap_err();
        assert!(matches!(
            error,
            ModelError::Http {
                status: Some(500),
                ..
            }
        ));
        assert!(!format!("{model:?}").contains("secret-must-not-be-debugged"));

        let endpoint = test_http_server("200 OK", br#"{"choices":[]}"#).await;
        let model = HttpModel::new(HttpModelConfig {
            endpoint,
            api_key: None,
            model: "local".into(),
            timeout: Duration::from_secs(2),
            max_response_bytes: 4,
        })
        .unwrap();
        assert!(matches!(
            model
                .complete(
                    &ChatRequest {
                        model: "caller".into(),
                        messages: vec![],
                        tools: None,
                        tool_choice: None
                    },
                    &CancellationToken::new()
                )
                .await,
            Err(ModelError::ResponseTooLarge { limit: 4 })
        ));
    }
}
