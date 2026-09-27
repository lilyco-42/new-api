package controller

import (
	"errors"
	"io"
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
