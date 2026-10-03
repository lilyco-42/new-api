package controller

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/dto"
	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

const admissionRequestID = "123e4567-e89b-42d3-a456-426614174000"
const admissionNextRequestID = "123e4567-e89b-42d3-a456-426614174001"

func sendAdmissionTurn(t *testing.T, userID int, sessionID, requestID string, requestContext context.Context) *httptest.ResponseRecorder {
	t.Helper()
	body, err := common.Marshal(dto.AgentDSHTurnRequest{
		SessionID: sessionID, RequestID: requestID, Model: "site-model", Text: "Read the actual repository",
	})
	require.NoError(t, err)
	response := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(response)
	c.Request = httptest.NewRequest(http.MethodPost, "/api/agent/dsh/turns", strings.NewReader(string(body))).WithContext(requestContext)
	c.Request.Header.Set("Content-Type", "application/json")
	c.Set("id", userID)
	AgentDSHTurn(c)
	return response
}

func configureAdmissionRuntime(t *testing.T) *int {
	t.Helper()
	// The real controller performs HTTP forwarding; only the external runtime
	// is controlled here. These calls do not prove DSH task execution or Stop.
	calls := new(int)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		*calls++
		body, err := io.ReadAll(r.Body)
		require.NoError(t, err)
		var request agentDSHWireTurnRequest
		require.NoError(t, common.Unmarshal(body, &request))
		response, err := common.Marshal(agentDSHWireTurnResponse{Version: 1, RequestID: request.RequestID, Answer: "Runtime result"})
		require.NoError(t, err)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(response)
	}))
	t.Cleanup(server.Close)
	t.Setenv("LAIN42_DSH_BASE_URL", server.URL)
	t.Setenv("LAIN42_DSH_BRIDGE_SECRET", "0123456789abcdef0123456789abcdef")
	return calls
}

func TestAgentDSHAdmissionRejectsPersistedStopAndDoesNotAffectNextRequest(t *testing.T) {
	setupAgentDSHControllerTest(t)
	gin.SetMode(gin.TestMode)
	session, err := model.CreateAgentDSHSession(41, time.Now().UTC())
	require.NoError(t, err)
	_, err = model.RequestOwnedAgentDSHCancellation(41, session.SessionId, admissionRequestID, time.Now().UTC())
	require.NoError(t, err)
	calls := configureAdmissionRuntime(t)

	for range 2 {
		response := sendAdmissionTurn(t, 41, session.SessionId, admissionRequestID, context.Background())
		assert.Equal(t, http.StatusConflict, response.Code)
		assert.Contains(t, response.Body.String(), "AGENT_DSH_CANCEL_REQUESTED")
	}
	assert.Zero(t, *calls, "Stop-before-admission and retries must not reach the runtime")
	response := sendAdmissionTurn(t, 41, session.SessionId, admissionNextRequestID, context.Background())
	assert.Equal(t, http.StatusOK, response.Code)
	assert.Equal(t, 1, *calls)
	owned, err := model.GetOwnedAgentDSHSession(41, session.SessionId)
	require.NoError(t, err)
	assert.Equal(t, 2, owned.RequestCount)
}

func TestAgentDSHAdmissionRetriesReserveOneIdentityAndRejectOtherAccount(t *testing.T) {
	setupAgentDSHControllerTest(t)
	gin.SetMode(gin.TestMode)
	session, err := model.CreateAgentDSHSession(41, time.Now().UTC())
	require.NoError(t, err)
	calls := configureAdmissionRuntime(t)
	for range 2 {
		assert.Equal(t, http.StatusOK, sendAdmissionTurn(t, 41, session.SessionId, admissionRequestID, context.Background()).Code)
	}
	assert.Equal(t, http.StatusNotFound, sendAdmissionTurn(t, 42, session.SessionId, admissionNextRequestID, context.Background()).Code)
	assert.Equal(t, 2, *calls, "retry forwarding is allowed; DSH owns execution deduplication")
	owned, err := model.GetOwnedAgentDSHSession(41, session.SessionId)
	require.NoError(t, err)
	assert.Equal(t, 1, owned.RequestCount)
	var count int64
	require.NoError(t, model.DB.Model(&model.AgentDSHRequest{}).Where("user_id = ?", 42).Count(&count).Error)
	assert.Zero(t, count)
}

func TestAgentDSHAdmissionAtCapacityStillAllowsExistingIdentityRetry(t *testing.T) {
	setupAgentDSHControllerTest(t)
	gin.SetMode(gin.TestMode)
	session, err := model.CreateAgentDSHSession(41, time.Now().UTC())
	require.NoError(t, err)
	_, err = model.ReserveOwnedAgentDSHRequest(41, session.SessionId, admissionRequestID, time.Now().UTC())
	require.NoError(t, err)
	require.NoError(t, model.DB.Model(&model.AgentDSHSession{}).Where("id = ?", session.Id).UpdateColumn("request_count", model.AgentDSHSessionRequestLimit).Error)
	calls := configureAdmissionRuntime(t)
	response := sendAdmissionTurn(t, 41, session.SessionId, admissionNextRequestID, context.Background())
	assert.Equal(t, http.StatusConflict, response.Code)
	assert.Contains(t, response.Body.String(), "AGENT_DSH_REQUEST_LIMIT")
	assert.Zero(t, *calls)
	assert.Equal(t, http.StatusOK, sendAdmissionTurn(t, 41, session.SessionId, admissionRequestID, context.Background()).Code)
	assert.Equal(t, 1, *calls)
}

func TestAgentDSHAdmissionDatabaseFailureDoesNotForward(t *testing.T) {
	setupAgentDSHControllerTest(t)
	gin.SetMode(gin.TestMode)
	session, err := model.CreateAgentDSHSession(41, time.Now().UTC())
	require.NoError(t, err)
	calls := configureAdmissionRuntime(t)
	const callbackName = "test:reject-agent-request-insert"
	require.NoError(t, model.DB.Callback().Create().Before("gorm:create").Register(callbackName, func(tx *gorm.DB) {
		if tx.Statement.Table == "agent_dsh_requests" {
			tx.AddError(errors.New("controlled database failure"))
		}
	}))
	t.Cleanup(func() { _ = model.DB.Callback().Create().Remove(callbackName) })
	response := sendAdmissionTurn(t, 41, session.SessionId, admissionRequestID, context.Background())
	assert.Equal(t, http.StatusServiceUnavailable, response.Code)
	assert.Contains(t, response.Body.String(), "AGENT_DSH_ADMISSION_UNAVAILABLE")
	assert.NotContains(t, response.Body.String(), "controlled database failure")
	assert.Zero(t, *calls)
	owned, err := model.GetOwnedAgentDSHSession(41, session.SessionId)
	require.NoError(t, err)
	assert.Zero(t, owned.RequestCount, "failed insertion rolls back the slot")
}

func TestAgentDSHAdmissionObserverDisconnectDoesNotPersistStop(t *testing.T) {
	setupAgentDSHControllerTest(t)
	gin.SetMode(gin.TestMode)
	session, err := model.CreateAgentDSHSession(41, time.Now().UTC())
	require.NoError(t, err)
	calls := configureAdmissionRuntime(t)
	requestContext, cancel := context.WithCancel(context.Background())
	cancel()
	response := sendAdmissionTurn(t, 41, session.SessionId, admissionRequestID, requestContext)
	assert.Equal(t, http.StatusBadGateway, response.Code)
	assert.Zero(t, *calls)
	reservation, err := model.ReserveOwnedAgentDSHRequest(41, session.SessionId, admissionRequestID, time.Now().UTC())
	require.NoError(t, err)
	assert.False(t, reservation.CancelRequested, "an observer's lost connection is not an explicit Stop")
	assert.Equal(t, http.StatusOK, sendAdmissionTurn(t, 41, session.SessionId, admissionRequestID, context.Background()).Code)
	assert.Equal(t, 1, *calls)
	owned, err := model.GetOwnedAgentDSHSession(41, session.SessionId)
	require.NoError(t, err)
	assert.Equal(t, 1, owned.RequestCount)
}
