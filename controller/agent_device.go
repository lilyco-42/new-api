package controller

import (
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
)

type createAgentPairingRequest struct {
	ReplaceDeviceID int64 `json:"replace_device_id,omitempty"`
}

type claimAgentPairingRequest struct {
	PairingTicket   string `json:"pairing_ticket"`
	DeviceName      string `json:"device_name"`
	DevicePublicKey string `json:"device_public_key"`
}

type confirmAgentPairingRequest struct {
	ConfirmationTicket string `json:"confirmation_ticket"`
}

type redeemAgentPairingRequest struct {
	PairingID    int64  `json:"pairing_id"`
	RedeemTicket string `json:"redeem_ticket"`
}

func CreateAgentPairing(c *gin.Context) {
	var request createAgentPairingRequest
	body, err := io.ReadAll(io.LimitReader(c.Request.Body, 4097))
	if err != nil || len(body) > 4096 {
		writeAgentError(c, http.StatusBadRequest, "AGENT_INVALID_REQUEST", "invalid request body")
		return
	}
	if strings.TrimSpace(string(body)) != "" {
		if err := common.Unmarshal(body, &request); err != nil {
			writeAgentError(c, http.StatusBadRequest, "AGENT_INVALID_REQUEST", "invalid request body")
			return
		}
	}
	if request.ReplaceDeviceID < 0 {
		writeAgentError(c, http.StatusBadRequest, "AGENT_INVALID_REQUEST", "invalid device id")
		return
	}
	pairing, err := service.CreateAgentPairing(c.GetInt("id"), request.ReplaceDeviceID)
	if err != nil {
		writeAgentServiceError(c, err)
		return
	}
	common.ApiSuccess(c, pairing)
}

func ClaimAgentPairing(c *gin.Context) {
	var request claimAgentPairingRequest
	if err := common.DecodeJson(c.Request.Body, &request); err != nil {
		writeAgentError(c, http.StatusBadRequest, "AGENT_INVALID_REQUEST", "invalid request body")
		return
	}
	claimed, err := service.ClaimAgentPairing(request.PairingTicket, request.DeviceName, request.DevicePublicKey)
	if err != nil {
		writeAgentServiceError(c, err)
		return
	}
	common.ApiSuccess(c, claimed)
}

func ConfirmAgentPairing(c *gin.Context) {
	pairingID, err := strconv.ParseInt(strings.TrimSpace(c.Param("id")), 10, 64)
	if err != nil || pairingID <= 0 {
		writeAgentError(c, http.StatusBadRequest, "AGENT_INVALID_REQUEST", "invalid pairing id")
		return
	}
	var request confirmAgentPairingRequest
	if err := common.DecodeJson(c.Request.Body, &request); err != nil {
		writeAgentError(c, http.StatusBadRequest, "AGENT_INVALID_REQUEST", "invalid request body")
		return
	}
	if err := service.ConfirmAgentPairing(c.GetInt("id"), pairingID, request.ConfirmationTicket); err != nil {
		writeAgentServiceError(c, err)
		return
	}
	common.ApiSuccess(c, gin.H{"pairing_id": pairingID, "status": "confirmed"})
}

func RedeemAgentPairing(c *gin.Context) {
	var request redeemAgentPairingRequest
	if err := common.DecodeJson(c.Request.Body, &request); err != nil {
		writeAgentError(c, http.StatusBadRequest, "AGENT_INVALID_REQUEST", "invalid request body")
		return
	}
	credential, err := service.RedeemAgentPairing(request.PairingID, request.RedeemTicket)
	if err != nil {
		writeAgentServiceError(c, err)
		return
	}
	common.ApiSuccess(c, credential)
}

func ListAgentDevices(c *gin.Context) {
	devices, err := service.ListAgentDevices(c.GetInt("id"))
	if err != nil {
		writeAgentError(c, http.StatusInternalServerError, "AGENT_DEVICE_LIST_FAILED", "unable to list devices")
		return
	}
	common.ApiSuccess(c, devices)
}

// ListAgentRunEvents exposes a cursor-based, metadata-only bridge journal.
// Tool payloads and raw errors never leave the execution path or enter this
// response; clients use the cursor to render reconnect/interrupted state.
func ListAgentRunEvents(c *gin.Context) {
	deviceID, err := parseAgentQueryInt64(c, "device_id")
	if err != nil {
		writeAgentError(c, http.StatusBadRequest, "AGENT_INVALID_REQUEST", "invalid device id")
		return
	}
	afterEventID, err := parseAgentQueryInt64(c, "after_event_id")
	if err != nil {
		writeAgentError(c, http.StatusBadRequest, "AGENT_INVALID_REQUEST", "invalid event cursor")
		return
	}
	limit, err := parseAgentQueryInt64(c, "limit")
	if err != nil {
		writeAgentError(c, http.StatusBadRequest, "AGENT_INVALID_REQUEST", "invalid event limit")
		return
	}
	events, err := service.ListAgentRunEvents(c.GetInt("id"), deviceID, afterEventID, int(limit))
	if err != nil {
		if errors.Is(err, service.ErrAgentRunEventInvalid) {
			writeAgentError(c, http.StatusBadRequest, "AGENT_INVALID_REQUEST", "invalid event query")
			return
		}
		writeAgentError(c, http.StatusInternalServerError, "AGENT_EVENT_LIST_FAILED", "unable to list agent events")
		return
	}
	common.ApiSuccess(c, events)
}

func parseAgentQueryInt64(c *gin.Context, key string) (int64, error) {
	value := strings.TrimSpace(c.Query(key))
	if value == "" {
		return 0, nil
	}
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil || parsed < 0 {
		return 0, errors.New("invalid agent query integer")
	}
	return parsed, nil
}

func RevokeAgentDevice(c *gin.Context) {
	deviceID, err := strconv.ParseInt(strings.TrimSpace(c.Param("id")), 10, 64)
	if err != nil || deviceID <= 0 {
		writeAgentError(c, http.StatusBadRequest, "AGENT_INVALID_REQUEST", "invalid device id")
		return
	}
	if err := service.RevokeAgentDevice(c.GetInt("id"), deviceID); err != nil {
		writeAgentServiceError(c, err)
		return
	}
	common.ApiSuccess(c, gin.H{"device_id": deviceID, "status": "revoked"})
}

func writeAgentServiceError(c *gin.Context, err error) {
	if !service.IsAgentPairingClientError(err) {
		writeAgentError(c, http.StatusInternalServerError, "AGENT_INTERNAL_ERROR", "agent pairing service failed")
		return
	}
	status := http.StatusConflict
	code := "AGENT_PAIRING_CONFLICT"
	message := "pairing session is no longer usable"
	switch {
	case errors.Is(err, service.ErrAgentPairingInvalid), errors.Is(err, service.ErrAgentDeviceNotFound):
		status, code, message = http.StatusNotFound, "AGENT_NOT_FOUND", "pairing or device was not found"
	case errors.Is(err, service.ErrAgentPairingExpired):
		status, code, message = http.StatusGone, "AGENT_PAIRING_EXPIRED", "pairing session has expired"
	case errors.Is(err, service.ErrAgentPairingConfirmed):
		status, code, message = http.StatusConflict, "AGENT_PAIRING_NOT_CONFIRMED", "pairing session is awaiting user confirmation"
	case errors.Is(err, service.ErrAgentPairingConsumed):
		status, code, message = http.StatusConflict, "AGENT_PAIRING_CONSUMED", "pairing session has already been redeemed"
	}
	writeAgentError(c, status, code, message)
}

func writeAgentError(c *gin.Context, status int, code, message string) {
	c.AbortWithStatusJSON(status, gin.H{"success": false, "code": code, "message": message})
}
