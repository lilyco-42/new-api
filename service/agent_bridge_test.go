package service

import (
	"encoding/json"
	"errors"
	"testing"
	"time"

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
		"vcs.history",
		"code.search",
		"code.graph",
		"files.browse",
		"files.preview",
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

func TestAgentBridgeCapabilitiesAdvertiseWorkspaceReadTools(t *testing.T) {
	capabilities := AgentBridgeCapabilities()
	require.Contains(t, capabilities, "workspace.read")
	require.Contains(t, capabilities, "code.search")
	require.Contains(t, capabilities, "vcs.history")
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

func TestAgentBridgeHubReportsDesktopPresenceOnlyForItsOwner(t *testing.T) {
	hub := NewAgentBridgeHub()
	hub.desktops[7] = &AgentBridgePeer{deviceID: 7, userID: 12, role: "desktop"}

	require.True(t, hub.DesktopConnected(7, 12))
	require.False(t, hub.DesktopConnected(7, 13))
	require.False(t, hub.DesktopConnected(8, 12))
}

func TestRevokeDeviceInterruptsPendingRequestsAndFencesTheBridge(t *testing.T) {
	hub := NewAgentBridgeHub()
	desktop := &AgentBridgePeer{deviceID: 7, userID: 12, role: "desktop"}
	browser := &AgentBridgePeer{deviceID: 7, userID: 12, role: "browser"}
	hub.desktops[7] = desktop
	key := bridgeRequestKey(7, "request-1")
	hub.pending[key] = pendingAgentBridgeRequest{
		browser:   browser,
		desktop:   desktop,
		deviceID:  7,
		userID:    12,
		requestID: "request-1",
		operation: "github.issues.list",
		expires:   time.Now().Add(time.Minute),
	}
	request := AgentBridgeEnvelope{
		Type:      AgentBridgeMessageToolRequest,
		RequestID: "request-2",
		Operation: "github.issues.list",
		Params:    json.RawMessage(`{"repo":"owner/name"}`),
	}
	persistenceCalled := false

	err := hub.RevokeDevice(12, 7, func() error {
		persistenceCalled = true
		require.False(t, hub.DesktopConnected(7, 12), "the device is fenced while its revocation is persisted")
		_, pending := hub.pending[key]
		require.False(t, pending, "in-flight requests are canceled when revocation starts")
		return nil
	})

	require.NoError(t, err)
	require.True(t, persistenceCalled)
	require.False(t, hub.DesktopConnected(7, 12))
	require.ErrorIs(t, hub.ForwardToolRequest(browser, request), ErrAgentBridgeUnauthorized)
}

func TestRevokeDeviceRestoresBridgeWhenPersistenceFails(t *testing.T) {
	hub := NewAgentBridgeHub()
	hub.desktops[7] = &AgentBridgePeer{deviceID: 7, userID: 12, role: "desktop"}
	persistErr := errors.New("storage unavailable")

	err := hub.RevokeDevice(12, 7, func() error { return persistErr })

	require.ErrorIs(t, err, persistErr)
	require.True(t, hub.DesktopConnected(7, 12), "a failed database update must not permanently disconnect an authorized device")
}

func TestRevokeDeviceCannotDisconnectAnotherUsersDesktop(t *testing.T) {
	hub := NewAgentBridgeHub()
	desktop := &AgentBridgePeer{deviceID: 7, userID: 13, role: "desktop"}
	hub.desktops[7] = desktop
	persistenceCalled := false

	err := hub.RevokeDevice(12, 7, func() error {
		persistenceCalled = true
		return nil
	})

	require.ErrorIs(t, err, ErrAgentBridgeUnauthorized)
	require.False(t, persistenceCalled)
	require.Same(t, desktop, hub.desktops[7])
	require.True(t, hub.DesktopConnected(7, 13))
}

func TestForwardToolResultRejectsStaleOrMismatchedDesktop(t *testing.T) {
	hub := NewAgentBridgeHub()
	active := &AgentBridgePeer{deviceID: 7, userID: 12, role: "desktop"}
	stale := &AgentBridgePeer{deviceID: 7, userID: 12, role: "desktop"}
	hub.desktops[7] = active
	key := bridgeRequestKey(7, "request-1")
	hub.pending[key] = pendingAgentBridgeRequest{
		browser:   &AgentBridgePeer{deviceID: 7, userID: 12, role: "browser"},
		desktop:   active,
		deviceID:  7,
		userID:    12,
		requestID: "request-1",
		operation: "github.issues.list",
		expires:   time.Now().Add(time.Minute),
	}
	envelope := AgentBridgeEnvelope{
		Type:      AgentBridgeMessageToolResult,
		RequestID: "request-1",
		Result:    json.RawMessage(`{"ok":true}`),
	}

	for _, desktop := range []*AgentBridgePeer{
		stale,
		&AgentBridgePeer{deviceID: 7, userID: 13, role: "desktop"},
	} {
		require.ErrorIs(t, hub.ForwardToolResult(desktop, envelope), ErrAgentBridgeUnauthorized)
		_, stillPending := hub.pending[key]
		require.True(t, stillPending, "rejected responses must not consume the active request")
	}
}

func TestUnregisterStaleDesktopOnlyInterruptsItsOwnRequests(t *testing.T) {
	hub := NewAgentBridgeHub()
	stale := &AgentBridgePeer{deviceID: 7, userID: 12, role: "desktop"}
	active := &AgentBridgePeer{deviceID: 7, userID: 12, role: "desktop"}
	hub.desktops[7] = active
	for requestID, desktop := range map[string]*AgentBridgePeer{
		"old-request": stale,
		"new-request": active,
	} {
		hub.pending[bridgeRequestKey(7, requestID)] = pendingAgentBridgeRequest{
			desktop:   desktop,
			deviceID:  7,
			userID:    12,
			requestID: requestID,
			operation: "github.issues.list",
			expires:   time.Now().Add(time.Minute),
		}
	}

	hub.Unregister(stale)

	_, oldRequestRemains := hub.pending[bridgeRequestKey(7, "old-request")]
	_, newRequestRemains := hub.pending[bridgeRequestKey(7, "new-request")]
	require.False(t, oldRequestRemains, "the disconnected peer's request must be interrupted")
	require.True(t, newRequestRemains, "a replacement peer's in-flight request must remain intact")
	require.Same(t, active, hub.desktops[7], "a stale disconnect must not unregister the replacement")
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
