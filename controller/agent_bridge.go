package controller

import (
	"net/http"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
)

var agentBridgeUpgrader = websocket.Upgrader{
	ReadBufferSize:  8 * 1024,
	WriteBufferSize: 8 * 1024,
	CheckOrigin:     agentBridgeOriginAllowed,
}

func agentBridgeOriginAllowed(request *http.Request) bool {
	rawOrigin := strings.TrimSpace(request.Header.Get("Origin"))
	if rawOrigin == "" {
		// Native Tauri WebSocket clients do not always send Origin. The desktop
		// still has to authenticate with a one-time device credential below.
		return true
	}
	origin, err := common.NormalizeOrigin(rawOrigin)
	if err != nil {
		return false
	}
	scheme := "http"
	if request.TLS != nil {
		scheme = "https"
	}
	requestOrigin, err := common.NormalizeOrigin(scheme + "://" + request.Host)
	if err == nil && origin == requestOrigin {
		return true
	}
	for _, trustedOrigin := range common.SessionCookieTrustedURLs {
		if origin == trustedOrigin {
			return true
		}
	}
	return false
}

func readAgentBridgeHello(conn *websocket.Conn) (service.AgentBridgeEnvelope, error) {
	conn.SetReadLimit(service.AgentBridgeMaxMessageBytes)
	_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	var envelope service.AgentBridgeEnvelope
	if err := conn.ReadJSON(&envelope); err != nil {
		return envelope, service.ErrAgentBridgeInvalid
	}
	if err := service.ValidateAgentBridgeHello(envelope); err != nil {
		return envelope, service.ErrAgentBridgeInvalid
	}
	return envelope, nil
}

func AgentBridgeDesktop(c *gin.Context) {
	conn, err := agentBridgeUpgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		return
	}
	defer conn.Close()

	hello, err := readAgentBridgeHello(conn)
	if err != nil {
		common.SysLog("agent bridge desktop rejected hello: invalid envelope")
		return
	}
	if strings.TrimSpace(hello.Credential) == "" {
		common.SysLog("agent bridge desktop rejected hello: missing credential")
		return
	}
	device, err := service.GetAgentDeviceByCredential(hello.Credential)
	if err != nil || device == nil {
		common.SysLog("agent bridge desktop rejected hello: unknown credential")
		return
	}
	if hello.DeviceID != 0 && hello.DeviceID != device.Id {
		common.SysLog("agent bridge desktop rejected hello: device id mismatch")
		return
	}
	hub := service.DefaultAgentBridgeHub()
	peer, err := hub.RegisterDesktop(device.Id, device.UserId, conn)
	if err != nil {
		return
	}
	defer hub.Unregister(peer)
	stopHeartbeat := make(chan struct{})
	defer close(stopHeartbeat)
	_ = conn.SetReadDeadline(time.Now().Add(90 * time.Second))
	if err := hub.Send(peer, service.AgentBridgeEnvelope{
		Type:            service.AgentBridgeMessageHelloAck,
		ProtocolVersion: service.AgentBridgeProtocolVersion,
		Capabilities:    service.AgentBridgeCapabilities(),
		DeviceID:        device.Id,
	}); err != nil {
		return
	}
	// Headless companions do not have a browser event loop to schedule their
	// own heartbeat. Keep the outbound connection alive from the server and
	// let the companion answer with a pong, which also refreshes the read
	// deadline below.
	go func() {
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				if err := hub.Send(peer, service.AgentBridgeEnvelope{Type: service.AgentBridgeMessagePing}); err != nil {
					return
				}
			case <-stopHeartbeat:
				return
			}
		}
	}()

	for {
		var envelope service.AgentBridgeEnvelope
		if err := conn.ReadJSON(&envelope); err != nil {
			return
		}
		_ = conn.SetReadDeadline(time.Now().Add(90 * time.Second))
		switch envelope.Type {
		case service.AgentBridgeMessageToolResult, service.AgentBridgeMessageToolError:
			if err := hub.ForwardToolResult(peer, envelope); err != nil {
				_ = hub.Send(peer, service.AgentBridgeEnvelope{
					Type:      service.AgentBridgeMessageToolError,
					RequestID: envelope.RequestID,
					Error:     err.Error(),
				})
			}
		case service.AgentBridgeMessagePing:
			if err := hub.Send(peer, service.AgentBridgeEnvelope{Type: service.AgentBridgeMessagePong}); err != nil {
				return
			}
		case service.AgentBridgeMessagePong:
			// The headless companion answers the server heartbeat. Reading it
			// is enough to refresh the read deadline and keep the session alive.
		default:
			return
		}
	}
}

func AgentBridgeBrowser(c *gin.Context) {
	conn, err := agentBridgeUpgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		return
	}
	defer conn.Close()

	hello, err := readAgentBridgeHello(conn)
	if err != nil || hello.DeviceID <= 0 {
		return
	}
	device, err := service.GetAgentDevice(c.GetInt("id"), hello.DeviceID)
	if err != nil || device == nil {
		return
	}
	hub := service.DefaultAgentBridgeHub()
	peer, err := hub.RegisterBrowser(device.UserId, device.Id, conn)
	if err != nil {
		return
	}
	defer hub.Unregister(peer)
	_ = conn.SetReadDeadline(time.Now().Add(90 * time.Second))
	if err := hub.Send(peer, service.AgentBridgeEnvelope{
		Type:            service.AgentBridgeMessageHelloAck,
		ProtocolVersion: service.AgentBridgeProtocolVersion,
		Capabilities:    service.AgentBridgeCapabilities(),
		DeviceID:        device.Id,
	}); err != nil {
		return
	}

	for {
		var envelope service.AgentBridgeEnvelope
		if err := conn.ReadJSON(&envelope); err != nil {
			return
		}
		_ = conn.SetReadDeadline(time.Now().Add(90 * time.Second))
		switch envelope.Type {
		case service.AgentBridgeMessageToolRequest:
			if err := hub.ForwardToolRequest(peer, envelope); err != nil {
				_ = hub.Send(peer, service.AgentBridgeEnvelope{
					Type:      service.AgentBridgeMessageToolError,
					RequestID: envelope.RequestID,
					Error:     err.Error(),
				})
			}
		case service.AgentBridgeMessagePing:
			if err := hub.Send(peer, service.AgentBridgeEnvelope{Type: service.AgentBridgeMessagePong}); err != nil {
				return
			}
		default:
			return
		}
	}
}
