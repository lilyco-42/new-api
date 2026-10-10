package controller

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
)

func AgentGitHubWorkflowEvidence(c *gin.Context) {
	repo := strings.TrimSpace(c.Query("repo"))
	var runID int64
	var err error
	if raw := c.Query("run_id"); raw != "" {
		runID, err = strconv.ParseInt(raw, 10, 64)
		if err != nil || runID <= 0 {
			writeAgentError(c, http.StatusBadRequest, "AGENT_WORKFLOW_INVALID", "run_id must be a positive integer")
			return
		}
	}
	if !service.ValidWorkflowEvidenceTarget(repo, runID) {
		writeAgentError(c, http.StatusBadRequest, "AGENT_WORKFLOW_INVALID", "repo must be owner/name")
		return
	}
	_, token, err := model.GetAgentGitHubCredential(c.GetInt("id"))
	if err != nil || strings.TrimSpace(token) == "" {
		writeAgentError(c, http.StatusConflict, "AGENT_GITHUB_NOT_CONNECTED", "connect GitHub for this account before reading workflow evidence")
		return
	}
	evidence, err := service.ReadAgentWorkflowEvidence(c.Request.Context(), repo, runID, token)
	if err != nil {
		writeAgentError(c, http.StatusBadGateway, "AGENT_WORKFLOW_UNAVAILABLE", err.Error())
		return
	}
	common.ApiSuccess(c, evidence)
}
