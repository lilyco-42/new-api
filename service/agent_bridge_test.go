package service

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestValidateAgentBridgeEnvelopeKeepsOperationsBounded(t *testing.T) {
	valid := AgentBridgeEnvelope{
		Type:      AgentBridgeMessageToolRequest,
		RequestID: "request-1",
		Operation: "github.issues.list",
		Params:    json.RawMessage(`{"repo":"owner/name"}`),
	}
	require.NoError(t, validateAgentBridgeEnvelope(valid))

	unknown := valid
	unknown.Operation = "shell.exec"
	require.ErrorIs(t, validateAgentBridgeEnvelope(unknown), ErrAgentBridgeInvalid)

	malformed := valid
	malformed.Params = json.RawMessage(`{"repo":`)
	require.ErrorIs(t, validateAgentBridgeEnvelope(malformed), ErrAgentBridgeInvalid)
}

func TestValidateAgentBridgeEnvelopeAcceptsReadonlyGithubOperations(t *testing.T) {
	for _, operation := range []string{
		"github.auth.status",
		"github.repositories.search",
		"github.pull_requests.list",
	} {
		envelope := AgentBridgeEnvelope{
			Type:      AgentBridgeMessageToolRequest,
			RequestID: "request-" + operation,
			Operation: operation,
			Params:    json.RawMessage(`{}`),
		}
		require.NoError(t, validateAgentBridgeEnvelope(envelope))
	}
	result := AgentBridgeEnvelope{
		Type:      AgentBridgeMessageToolError,
		RequestID: "request-error",
		Error:     "tool failed",
	}
	require.NoError(t, validateAgentBridgeEnvelope(result))
}

func TestValidateAgentBridgeEnvelopeAcceptsBoundedMcpOperations(t *testing.T) {
	for _, operation := range []string{"mcp.list", "mcp.call"} {
		envelope := AgentBridgeEnvelope{
			Type:      AgentBridgeMessageToolRequest,
			RequestID: "request-" + operation,
			Operation: operation,
			Params:    json.RawMessage(`{"server_id":"local","tool_name":"echo","arguments":{}}`),
		}
		require.NoError(t, validateAgentBridgeEnvelope(envelope))
	}
}

func TestAgentBridgeRequestKeyScopesDevice(t *testing.T) {
	require.NotEqual(t, bridgeRequestKey(1, "same"), bridgeRequestKey(2, "same"))
}

func TestValidateAgentBridgeHelloKeepsVersionAndCapabilitiesAdditive(t *testing.T) {
	require.NoError(t, ValidateAgentBridgeHello(AgentBridgeEnvelope{
		Type:         AgentBridgeMessageHello,
		Capabilities: []string{"github.read", "mcp.list"},
	}))
	require.NoError(t, ValidateAgentBridgeHello(AgentBridgeEnvelope{
		Type:            AgentBridgeMessageHello,
		ProtocolVersion: AgentBridgeProtocolVersion,
	}))
	require.Error(t, ValidateAgentBridgeHello(AgentBridgeEnvelope{
		Type:            AgentBridgeMessageHello,
		ProtocolVersion: AgentBridgeProtocolVersion + 1,
	}))
	require.Error(t, ValidateAgentBridgeHello(AgentBridgeEnvelope{
		Type:            AgentBridgeMessageHello,
		ProtocolVersion: -1,
	}))
	require.Error(t, ValidateAgentBridgeHello(AgentBridgeEnvelope{
		Type:         AgentBridgeMessageHello,
		Capabilities: []string{"mcp.list", "mcp.list"},
	}))
}
