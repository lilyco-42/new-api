package controller

import (
	"errors"
	"io"
	"mime"
	"net/http"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

// CreateAgentWebSession deliberately accepts no body. The authenticated
// platform identity is the only source of ownership; callers cannot choose a
// user, DSH session id, workspace, or working directory.
func CreateAgentWebSession(c *gin.Context) {
	body, err := io.ReadAll(io.LimitReader(c.Request.Body, 4097))
	if err != nil || len(body) > 4096 || strings.TrimSpace(string(body)) != "" {
		writeAgentError(c, http.StatusBadRequest, "AGENT_INVALID_REQUEST", "create a session without a request body")
		return
	}
	session, err := service.CreateAgentWebSession(c.GetInt("id"))
	if err != nil {
		writeAgentWebSessionError(c, err)
		return
	}
	common.ApiSuccess(c, session)
}

func ListAgentWebSessions(c *gin.Context) {
	limit := parseBoundedAgentInt(c.Query("limit"), 20, 1, service.AgentWebSessionMaxPageSize)
	sessions, err := service.ListAgentWebSessions(c.GetInt("id"), limit)
	if err != nil {
		writeAgentWebSessionError(c, err)
		return
	}
	common.ApiSuccess(c, sessions)
}

func RevokeAgentWebSession(c *gin.Context) {
	if err := service.RevokeAgentWebSession(c.GetInt("id"), c.Param("id")); err != nil {
		writeAgentWebSessionError(c, err)
		return
	}
	common.ApiSuccess(c, gin.H{"status": "revoked"})
}

type agentWebTurnRequest struct {
	SessionID string `json:"session_id"`
	Text      string `json:"text"`
	RequestID string `json:"request_id,omitempty"`
	Model     string `json:"model,omitempty"`
}

// SubmitAgentWebTurn accepts only the public session id and user text. The
// authenticated account and internal DSH session are resolved server-side.
func SubmitAgentWebTurn(c *gin.Context) {
	mediaType, _, mediaErr := mime.ParseMediaType(c.GetHeader("Content-Type"))
	if mediaErr != nil || !strings.EqualFold(mediaType, "application/json") {
		writeAgentError(c, http.StatusUnsupportedMediaType, "AGENT_CONTENT_TYPE_REQUIRED", "application/json is required")
		return
	}
	body, err := io.ReadAll(io.LimitReader(c.Request.Body, service.AgentWebTurnMaxBodyBytes+1))
	if err != nil || len(body) == 0 || len(body) > service.AgentWebTurnMaxBodyBytes {
		writeAgentError(c, http.StatusBadRequest, "AGENT_INVALID_REQUEST", "invalid request body")
		return
	}
	var fields map[string]any
	if err := common.Unmarshal(body, &fields); err != nil || len(fields) < 2 || len(fields) > 4 {
		writeAgentError(c, http.StatusBadRequest, "AGENT_INVALID_REQUEST", "request must contain session_id, text, and optional request_id and model")
		return
	}
	if _, ok := fields["session_id"]; !ok {
		writeAgentError(c, http.StatusBadRequest, "AGENT_INVALID_REQUEST", "request must contain session_id and text")
		return
	}
	if _, ok := fields["text"]; !ok {
		writeAgentError(c, http.StatusBadRequest, "AGENT_INVALID_REQUEST", "request must contain session_id and text")
		return
	}
	for key := range fields {
		if key != "session_id" && key != "text" && key != "request_id" && key != "model" {
			writeAgentError(c, http.StatusBadRequest, "AGENT_INVALID_REQUEST", "request contains an unsupported field")
			return
		}
	}
	if rawRequestID, ok := fields["request_id"]; ok {
		if _, valid := rawRequestID.(string); !valid {
			writeAgentError(c, http.StatusBadRequest, "AGENT_INVALID_REQUEST", "request_id must be a string")
			return
		}
	}
	if rawModel, ok := fields["model"]; ok {
		if _, valid := rawModel.(string); !valid {
			writeAgentError(c, http.StatusBadRequest, "AGENT_INVALID_REQUEST", "model must be a string")
			return
		}
	}
	var request agentWebTurnRequest
	if err := common.Unmarshal(body, &request); err != nil || strings.TrimSpace(request.Text) == "" || len([]byte(request.Text)) > service.AgentWebTurnMaxTextBytes {
		writeAgentError(c, http.StatusBadRequest, "AGENT_INVALID_REQUEST", "text is required and must be at most 24 KiB")
		return
	}
	result, err := service.SubmitAgentWebTurn(c.Request.Context(), c.GetInt("id"), request.SessionID, request.Text, request.RequestID, request.Model)
	if err != nil {
		writeAgentWebTurnError(c, err)
		return
	}
	common.ApiSuccess(c, result)
}

func writeAgentWebTurnError(c *gin.Context, err error) {
	switch {
	case errors.Is(err, gorm.ErrRecordNotFound):
		writeAgentError(c, http.StatusNotFound, "AGENT_SESSION_NOT_FOUND", "session was not found")
	case errors.Is(err, service.ErrAgentTurnInvalidRequest), errors.Is(err, service.ErrAgentWebSessionInvalid):
		writeAgentError(c, http.StatusBadRequest, "AGENT_INVALID_REQUEST", "invalid session or turn request")
	case errors.Is(err, service.ErrAgentTurnBridgeDisabled):
		writeAgentError(c, http.StatusServiceUnavailable, "AGENT_TURN_UNAVAILABLE", "agent turn service is not configured")
	case errors.Is(err, service.ErrAgentTurnBridgeTimeout):
		writeAgentError(c, http.StatusGatewayTimeout, "AGENT_TURN_TIMEOUT", "the agent took too long to respond; try again")
	case errors.Is(err, service.ErrAgentTurnBridgeFailed):
		writeAgentError(c, http.StatusBadGateway, "AGENT_TURN_FAILED", "the agent could not complete this turn; try again")
	default:
		writeAgentError(c, http.StatusInternalServerError, "AGENT_TURN_INTERNAL", "unable to access this agent session")
	}
}

func writeAgentWebSessionError(c *gin.Context, err error) {
	switch {
	case errors.Is(err, gorm.ErrRecordNotFound):
		writeAgentError(c, http.StatusNotFound, "AGENT_SESSION_NOT_FOUND", "session was not found")
	case errors.Is(err, service.ErrAgentWebSessionInvalid):
		writeAgentError(c, http.StatusBadRequest, "AGENT_INVALID_REQUEST", "invalid session request")
	default:
		writeAgentError(c, http.StatusInternalServerError, "AGENT_SESSION_FAILED", "unable to access agent session")
	}
}
