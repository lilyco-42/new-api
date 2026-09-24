package service

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/QuantumNous/new-api/model"
	"github.com/gorilla/websocket"
)

const (
	// AgentBridgeProtocolVersion is the wire-contract version. New fields are
	// additive; a peer that omits the field is treated as version 1 for
	// backwards compatibility with the first released bridge.
	AgentBridgeProtocolVersion    = 1
	AgentBridgeMessageHello       = "hello"
	AgentBridgeMessageHelloAck    = "hello_ack"
	AgentBridgeMessageToolRequest = "tool_request"
	AgentBridgeMessageToolResult  = "tool_result"
	AgentBridgeMessageToolError   = "tool_error"
	AgentBridgeMessagePing        = "ping"
	AgentBridgeMessagePong        = "pong"
	AgentBridgeMaxMessageBytes    = 128 * 1024
	AgentBridgeRequestTTL         = 45 * time.Second
	AgentBridgeMaxCapabilities    = 32
	AgentBridgeMaxCapabilityBytes = 64
)

var agentBridgeCapabilities = []string{
	"github.read",
	"developer.cli.status",
	"workspace.read",
	"code.search",
	"vcs.history",
	"mcp.list",
	"mcp.call",
}

// AgentBridgeCapabilities returns a copy so callers cannot mutate the public
// capability advertisement shared by concurrent bridge connections.
func AgentBridgeCapabilities() []string {
	return append([]string(nil), agentBridgeCapabilities...)
}

var (
	ErrAgentBridgeOffline       = errors.New("agent device is offline")
	ErrAgentBridgeInvalid       = errors.New("invalid agent bridge message")
	ErrAgentBridgeUnauthorized  = errors.New("agent bridge device is not authorized")
	ErrAgentBridgeRequestExists = errors.New("agent bridge request id is already in use")
)

// AgentBridgeEnvelope is the transport envelope between a browser and a
// paired desktop. Params and Result are opaque structured JSON. Desktop
// credentials never travel in browser envelopes; the browser uses a
// short-lived dashboard access token only for its initial hello.
type AgentBridgeEnvelope struct {
	Type             string   `json:"type"`
	ProtocolVersion  int      `json:"protocol_version,omitempty"`
	Capabilities     []string `json:"capabilities,omitempty"`
	RequestID        string   `json:"request_id,omitempty"`
	DeviceID         int64    `json:"device_id,omitempty"`
	DesktopConnected bool     `json:"desktop_connected"`
	Credential       string   `json:"credential,omitempty"`
	// AccessToken is only accepted on the first browser hello. It is carried
	// inside the encrypted WebSocket payload because browsers cannot set an
	// Authorization header when constructing a WebSocket. Desktop peers keep
	// using the one-time device credential above.
	AccessToken string          `json:"access_token,omitempty"`
	Operation   string          `json:"operation,omitempty"`
	Params      json.RawMessage `json:"params,omitempty"`
	Result      json.RawMessage `json:"result,omitempty"`
	Error       string          `json:"error,omitempty"`
}

// ValidateAgentBridgeHello checks only the versioned handshake fields. The
// credential and device ownership are validated by the HTTP controller after
// this structural check. Version zero is accepted for legacy clients and is
// interpreted as v1.
func ValidateAgentBridgeHello(envelope AgentBridgeEnvelope) error {
	if envelope.Type != AgentBridgeMessageHello {
		return ErrAgentBridgeInvalid
	}
	if envelope.ProtocolVersion < 0 || envelope.ProtocolVersion > AgentBridgeProtocolVersion {
		return ErrAgentBridgeInvalid
	}
	if len(envelope.Capabilities) > AgentBridgeMaxCapabilities {
		return ErrAgentBridgeInvalid
	}
	if len(envelope.AccessToken) > 4096 || strings.ContainsAny(envelope.AccessToken, "\r\n\x00") {
		return ErrAgentBridgeInvalid
	}
	seen := make(map[string]struct{}, len(envelope.Capabilities))
	for _, capability := range envelope.Capabilities {
		if capability == "" || len(capability) > AgentBridgeMaxCapabilityBytes || strings.ContainsAny(capability, "\r\n\x00") {
			return ErrAgentBridgeInvalid
		}
		if _, exists := seen[capability]; exists {
			return ErrAgentBridgeInvalid
		}
		seen[capability] = struct{}{}
	}
	return nil
}

type AgentBridgePeer struct {
	conn     *websocket.Conn
	deviceID int64
	userID   int
	role     string
	writeMu  sync.Mutex
}

type pendingAgentBridgeRequest struct {
	browser   *AgentBridgePeer
	desktop   *AgentBridgePeer
	deviceID  int64
	userID    int
	requestID string
	operation string
	expires   time.Time
}

type AgentBridgeHub struct {
	mu              sync.Mutex
	desktops        map[int64]*AgentBridgePeer
	pending         map[string]pendingAgentBridgeRequest
	deviceLocks     map[int64]*sync.Mutex
	revokingDevices map[int64]int
	revokedDevices  map[int64]int
}

func NewAgentBridgeHub() *AgentBridgeHub {
	return &AgentBridgeHub{
		desktops:        make(map[int64]*AgentBridgePeer),
		pending:         make(map[string]pendingAgentBridgeRequest),
		deviceLocks:     make(map[int64]*sync.Mutex),
		revokingDevices: make(map[int64]int),
		revokedDevices:  make(map[int64]int),
	}
}

func (hub *AgentBridgeHub) lockDevice(deviceID int64) func() {
	if deviceID <= 0 {
		return func() {}
	}
	hub.mu.Lock()
	lock := hub.deviceLocks[deviceID]
	if lock == nil {
		lock = &sync.Mutex{}
		hub.deviceLocks[deviceID] = lock
	}
	hub.mu.Unlock()
	lock.Lock()
	return lock.Unlock
}

var defaultAgentBridgeHub = NewAgentBridgeHub()

func DefaultAgentBridgeHub() *AgentBridgeHub {
	return defaultAgentBridgeHub
}

func validateAgentBridgeEnvelope(envelope AgentBridgeEnvelope) error {
	if len(envelope.Type) == 0 || len(envelope.Type) > 32 {
		return ErrAgentBridgeInvalid
	}
	if len(envelope.RequestID) > 128 || strings.ContainsAny(envelope.RequestID, "\r\n") {
		return ErrAgentBridgeInvalid
	}
	if len(envelope.Operation) > 128 || strings.ContainsAny(envelope.Operation, "\r\n") {
		return ErrAgentBridgeInvalid
	}
	if len(envelope.Params) > AgentBridgeMaxMessageBytes || len(envelope.Result) > AgentBridgeMaxMessageBytes {
		return ErrAgentBridgeInvalid
	}
	if envelope.Type == AgentBridgeMessageToolRequest {
		switch envelope.Operation {
		case "developer.tools.status", "github.auth.status", "github.issues.list", "github.repositories.search", "github.pull_requests.list", "vcs.history", "code.search", "code.graph", "files.browse", "files.preview", "mcp.list", "mcp.call":
		default:
			return ErrAgentBridgeInvalid
		}
		if len(envelope.Params) == 0 || !json.Valid(envelope.Params) {
			return ErrAgentBridgeInvalid
		}
	}
	return nil
}

func bridgeRequestKey(deviceID int64, requestID string) string {
	return fmt.Sprintf("%d:%s", deviceID, requestID)
}

func recordAgentBridgeEvent(userID int, deviceID int64, requestID, eventType, operation string, input, output []byte, errorCode string) {
	// Journaling is deliberately best effort: a database hiccup must not turn a
	// valid local CLI result into a failed bridge request. The next reconnect
	// still receives the live result or explicit offline state.
	_, _ = model.AppendAgentRunEvent(model.AgentRunEventInput{
		UserId:       userID,
		DeviceId:     deviceID,
		RequestId:    requestID,
		EventType:    eventType,
		Operation:    operation,
		InputDigest:  model.AgentRunEventDigest(input),
		OutputDigest: model.AgentRunEventDigest(output),
		ErrorCode:    errorCode,
	})
}

func (hub *AgentBridgeHub) write(peer *AgentBridgePeer, envelope AgentBridgeEnvelope) error {
	peer.writeMu.Lock()
	defer peer.writeMu.Unlock()
	return peer.conn.WriteJSON(envelope)
}

func (hub *AgentBridgeHub) Send(peer *AgentBridgePeer, envelope AgentBridgeEnvelope) error {
	if peer == nil || peer.conn == nil {
		return ErrAgentBridgeOffline
	}
	return hub.write(peer, envelope)
}

func (hub *AgentBridgeHub) RegisterDesktop(deviceID int64, userID int, conn *websocket.Conn) (*AgentBridgePeer, error) {
	if deviceID <= 0 || userID <= 0 || conn == nil {
		return nil, ErrAgentBridgeUnauthorized
	}
	unlockDevice := hub.lockDevice(deviceID)
	defer unlockDevice()
	peer := &AgentBridgePeer{conn: conn, deviceID: deviceID, userID: userID, role: "desktop"}
	hub.mu.Lock()
	if _, revoking := hub.revokingDevices[deviceID]; revoking {
		hub.mu.Unlock()
		return nil, ErrAgentBridgeUnauthorized
	}
	if _, revoked := hub.revokedDevices[deviceID]; revoked {
		hub.mu.Unlock()
		return nil, ErrAgentBridgeUnauthorized
	}
	previous := hub.desktops[deviceID]
	hub.desktops[deviceID] = peer
	hub.mu.Unlock()
	if previous != nil {
		_ = previous.conn.Close()
	}
	return peer, nil
}

func (hub *AgentBridgeHub) RegisterBrowser(userID int, deviceID int64, conn *websocket.Conn) (*AgentBridgePeer, error) {
	if userID <= 0 || deviceID <= 0 || conn == nil {
		return nil, ErrAgentBridgeUnauthorized
	}
	unlockDevice := hub.lockDevice(deviceID)
	defer unlockDevice()
	peer := &AgentBridgePeer{conn: conn, deviceID: deviceID, userID: userID, role: "browser"}
	hub.mu.Lock()
	defer hub.mu.Unlock()
	if _, revoking := hub.revokingDevices[deviceID]; revoking {
		return nil, ErrAgentBridgeUnauthorized
	}
	if _, revoked := hub.revokedDevices[deviceID]; revoked {
		return nil, ErrAgentBridgeUnauthorized
	}
	return peer, nil
}

// DesktopConnected reports whether the paired desktop peer for this device is
// currently registered under the same user. Browser clients use this to
// distinguish an open relay socket from an actually reachable local device.
func (hub *AgentBridgeHub) DesktopConnected(deviceID int64, userID int) bool {
	hub.mu.Lock()
	defer hub.mu.Unlock()
	peer := hub.desktops[deviceID]
	_, revoking := hub.revokingDevices[deviceID]
	_, revoked := hub.revokedDevices[deviceID]
	return !revoking && !revoked && peer != nil && peer.userID == userID && peer.role == "desktop"
}

// RevokeDevice fences bridge traffic while the owner-scoped device record is
// revoked. The callback persists the revocation; a failed database update
// lifts the temporary fence, while a successful update permanently rejects
// stale in-memory credentials for the lifetime of this hub.
func (hub *AgentBridgeHub) RevokeDevice(userID int, deviceID int64, persist func() error) error {
	if userID <= 0 || deviceID <= 0 || persist == nil {
		return ErrAgentBridgeUnauthorized
	}
	unlockDevice := hub.lockDevice(deviceID)
	defer unlockDevice()

	hub.mu.Lock()
	if _, revoking := hub.revokingDevices[deviceID]; revoking {
		hub.mu.Unlock()
		return ErrAgentBridgeUnauthorized
	}
	if _, revoked := hub.revokedDevices[deviceID]; revoked {
		hub.mu.Unlock()
		return ErrAgentBridgeUnauthorized
	}
	if desktop := hub.desktops[deviceID]; desktop != nil && desktop.userID != userID {
		hub.mu.Unlock()
		return ErrAgentBridgeUnauthorized
	}
	hub.revokingDevices[deviceID] = userID
	var interrupted []pendingAgentBridgeRequest
	for key, pending := range hub.pending {
		if pending.deviceID == deviceID && pending.userID == userID {
			delete(hub.pending, key)
			interrupted = append(interrupted, pending)
		}
	}
	hub.mu.Unlock()

	persistErr := persist()
	desktopError := ErrAgentBridgeUnauthorized.Error()
	eventErrorCode := "device_revoked"
	if persistErr != nil {
		desktopError = ErrAgentBridgeOffline.Error()
		eventErrorCode = "device_revoke_failed"
	}
	for _, pending := range interrupted {
		recordAgentBridgeEvent(
			pending.userID,
			pending.deviceID,
			pending.requestID,
			model.AgentRunEventTypeToolInterrupted,
			pending.operation,
			nil,
			nil,
			eventErrorCode,
		)
		if pending.browser != nil && pending.browser.conn != nil {
			_ = hub.write(pending.browser, AgentBridgeEnvelope{
				Type:      AgentBridgeMessageToolError,
				RequestID: pending.requestID,
				Error:     desktopError,
			})
		}
	}

	hub.mu.Lock()
	var desktop *AgentBridgePeer
	if persistErr == nil {
		if current := hub.desktops[deviceID]; current != nil && current.userID == userID {
			delete(hub.desktops, deviceID)
			desktop = current
		}
		hub.revokedDevices[deviceID] = userID
	}
	delete(hub.revokingDevices, deviceID)
	hub.mu.Unlock()

	if persistErr == nil && desktop != nil && desktop.conn != nil {
		_ = desktop.conn.Close()
	}
	return persistErr
}

func (hub *AgentBridgeHub) ForwardToolRequest(browser *AgentBridgePeer, envelope AgentBridgeEnvelope) error {
	if browser == nil || browser.role != "browser" || browser.userID <= 0 || browser.deviceID <= 0 {
		return ErrAgentBridgeUnauthorized
	}
	if envelope.Type != AgentBridgeMessageToolRequest || envelope.RequestID == "" || envelope.Operation == "" {
		return ErrAgentBridgeInvalid
	}
	if err := validateAgentBridgeEnvelope(envelope); err != nil {
		return err
	}
	unlockDevice := hub.lockDevice(browser.deviceID)
	defer unlockDevice()
	key := bridgeRequestKey(browser.deviceID, envelope.RequestID)
	now := time.Now()
	var expired []pendingAgentBridgeRequest
	hub.mu.Lock()
	for pendingKey, pending := range hub.pending {
		if !pending.expires.After(now) {
			delete(hub.pending, pendingKey)
			expired = append(expired, pending)
		}
	}
	desktop := hub.desktops[browser.deviceID]
	hub.mu.Unlock()
	for _, pending := range expired {
		recordAgentBridgeEvent(
			pending.userID,
			pending.deviceID,
			pending.requestID,
			model.AgentRunEventTypeToolInterrupted,
			pending.operation,
			nil,
			nil,
			"request_expired",
		)
	}
	hub.mu.Lock()
	if _, revoking := hub.revokingDevices[browser.deviceID]; revoking {
		hub.mu.Unlock()
		return ErrAgentBridgeUnauthorized
	}
	if _, revoked := hub.revokedDevices[browser.deviceID]; revoked {
		hub.mu.Unlock()
		return ErrAgentBridgeUnauthorized
	}
	desktop = hub.desktops[browser.deviceID]
	if desktop == nil || desktop.userID != browser.userID {
		hub.mu.Unlock()
		return ErrAgentBridgeOffline
	}
	if _, exists := hub.pending[key]; exists {
		hub.mu.Unlock()
		return ErrAgentBridgeRequestExists
	}
	hub.pending[key] = pendingAgentBridgeRequest{
		browser:   browser,
		desktop:   desktop,
		deviceID:  browser.deviceID,
		userID:    browser.userID,
		requestID: envelope.RequestID,
		operation: envelope.Operation,
		expires:   time.Now().Add(AgentBridgeRequestTTL),
	}
	hub.mu.Unlock()
	recordAgentBridgeEvent(
		browser.userID,
		browser.deviceID,
		envelope.RequestID,
		model.AgentRunEventTypeToolRequested,
		envelope.Operation,
		envelope.Params,
		nil,
		"",
	)

	if err := hub.write(desktop, envelope); err != nil {
		hub.mu.Lock()
		delete(hub.pending, key)
		hub.mu.Unlock()
		recordAgentBridgeEvent(
			browser.userID,
			browser.deviceID,
			envelope.RequestID,
			model.AgentRunEventTypeToolInterrupted,
			envelope.Operation,
			nil,
			nil,
			"bridge_offline",
		)
		return ErrAgentBridgeOffline
	}
	return nil
}

func (hub *AgentBridgeHub) ForwardToolResult(desktop *AgentBridgePeer, envelope AgentBridgeEnvelope) error {
	if desktop == nil || desktop.role != "desktop" || desktop.deviceID <= 0 || desktop.userID <= 0 {
		return ErrAgentBridgeUnauthorized
	}
	if (envelope.Type != AgentBridgeMessageToolResult && envelope.Type != AgentBridgeMessageToolError) || envelope.RequestID == "" {
		return ErrAgentBridgeInvalid
	}
	if err := validateAgentBridgeEnvelope(envelope); err != nil {
		return err
	}
	unlockDevice := hub.lockDevice(desktop.deviceID)
	defer unlockDevice()
	key := bridgeRequestKey(desktop.deviceID, envelope.RequestID)
	hub.mu.Lock()
	pending, exists := hub.pending[key]
	if !exists {
		hub.mu.Unlock()
		return ErrAgentBridgeInvalid
	}
	if hub.desktops[desktop.deviceID] != desktop || pending.desktop != desktop || pending.userID != desktop.userID {
		hub.mu.Unlock()
		return ErrAgentBridgeUnauthorized
	}
	delete(hub.pending, key)
	hub.mu.Unlock()
	if !pending.expires.After(time.Now()) {
		recordAgentBridgeEvent(
			pending.userID,
			pending.deviceID,
			pending.requestID,
			model.AgentRunEventTypeToolInterrupted,
			pending.operation,
			nil,
			nil,
			"request_expired",
		)
		return ErrAgentBridgeInvalid
	}
	eventType := model.AgentRunEventTypeToolSucceeded
	errorCode := ""
	if envelope.Type == AgentBridgeMessageToolError {
		eventType = model.AgentRunEventTypeToolFailed
		errorCode = "tool_error"
	}
	recordAgentBridgeEvent(
		pending.userID,
		pending.deviceID,
		pending.requestID,
		eventType,
		pending.operation,
		nil,
		envelope.Result,
		errorCode,
	)
	if err := hub.write(pending.browser, envelope); err != nil {
		return ErrAgentBridgeOffline
	}
	return nil
}

func (hub *AgentBridgeHub) Unregister(peer *AgentBridgePeer) {
	if peer == nil {
		return
	}
	unlockDevice := hub.lockDevice(peer.deviceID)
	defer unlockDevice()
	hub.mu.Lock()
	currentDesktop := peer.role == "desktop" && hub.desktops[peer.deviceID] == peer
	if currentDesktop {
		delete(hub.desktops, peer.deviceID)
	}
	for key, pending := range hub.pending {
		if pending.browser == peer || pending.desktop == peer {
			delete(hub.pending, key)
			recordAgentBridgeEvent(
				pending.userID,
				pending.deviceID,
				pending.requestID,
				model.AgentRunEventTypeToolInterrupted,
				pending.operation,
				nil,
				nil,
				"bridge_offline",
			)
			if pending.browser != nil && pending.browser != peer {
				_ = hub.write(pending.browser, AgentBridgeEnvelope{
					Type:      AgentBridgeMessageToolError,
					RequestID: strings.TrimPrefix(key, fmt.Sprintf("%d:", peer.deviceID)),
					Error:     ErrAgentBridgeOffline.Error(),
				})
			}
		}
	}
	hub.mu.Unlock()
}
