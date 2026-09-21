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

func TestAgentBridgeRequestKeyScopesDevice(t *testing.T) {
	require.NotEqual(t, bridgeRequestKey(1, "same"), bridgeRequestKey(2, "same"))
}
