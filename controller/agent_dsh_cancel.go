package controller

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/dto"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
)

// CancelAgentDSHTurn persists Stop before delivery and keeps its request scope.
// Neither HTTP 202 nor a runtime receipt claims that executing work has settled.
func CancelAgentDSHTurn(c *gin.Context) {
	const bodyLimit = 4096
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, bodyLimit)
	storage, err := common.GetBodyStorage(c)
	if err != nil || storage.Size() <= 0 || storage.Size() > bodyLimit {
		writeAgentError(c, http.StatusBadRequest, "AGENT_DSH_INVALID_REQUEST", "invalid Agent cancellation request")
		return
	}
	body, err := storage.Bytes()
	var request dto.AgentDSHCancelRequest
	if err != nil || common.Unmarshal(body, &request) != nil || !modelAgentDSHSessionIDPattern.MatchString(request.SessionID) || !agentDSHTurnRequestID.MatchString(request.RequestID) {
		writeAgentError(c, http.StatusBadRequest, "AGENT_DSH_INVALID_REQUEST", "invalid Agent cancellation request")
		return
	}
	intent, err := model.RequestOwnedAgentDSHCancellation(c.GetInt("id"), request.SessionID, strings.ToLower(request.RequestID), time.Now().UTC())
	if errors.Is(err, model.ErrAgentDSHSessionNotFound) {
		writeAgentError(c, http.StatusNotFound, "AGENT_DSH_SESSION_NOT_FOUND", "Agent session was not found")
		return
	}
	if errors.Is(err, model.ErrAgentDSHRequestLimit) {
		writeAgentError(c, http.StatusConflict, "AGENT_DSH_REQUEST_LIMIT", "This chat reached its request limit. Existing messages can still be stopped.")
		return
	}
	if err != nil {
		writeAgentError(c, http.StatusServiceUnavailable, "AGENT_DSH_CANCELLATION_UNAVAILABLE", "The Agent could not save the Stop request. Retry Stop for this message.")
		return
	}
	receipt, deliveryErr := service.RequestAgentDSHCancellation(c.Request.Context(), intent.SessionId, intent.RequestId)
	data := gin.H{"session_id": intent.SessionId, "request_id": intent.RequestId, "cancel_requested": true, "delivery": "pending"}
	if deliveryErr == nil {
		data["delivery"] = "received"
		data["receipt"] = receipt
	}
	// Transport failure keeps intent durable and visible for same-identity retry.
	// Reconciliation and terminal observation are separate from this admission.
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusAccepted, gin.H{"success": true, "data": data})
}
