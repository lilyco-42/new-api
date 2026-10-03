package controller

import (
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
)

func sendDSHCancellation(t *testing.T, userID int, sessionID, requestID string) *httptest.ResponseRecorder {
	t.Helper()
	body, err := common.Marshal(dto.AgentDSHCancelRequest{SessionID: sessionID, RequestID: requestID})
	require.NoError(t, err)
	response := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(response)
	c.Set("id", userID)
	c.Request = httptest.NewRequest(http.MethodPost, "/api/agent/dsh/turns/cancel", strings.NewReader(string(body)))
	c.Request.Header.Set("Content-Type", "application/json")
	CancelAgentDSHTurn(c)
	return response
}

func TestCancelAgentDSHTurnPersistsBeforeDeliveryAndDoesNotDeclareSettlement(t *testing.T) {
	setupAgentDSHControllerTest(t)
	gin.SetMode(gin.TestMode)
	session, err := model.CreateAgentDSHSession(41, time.Now().UTC())
	require.NoError(t, err)
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls++
		// Observe committed intent from a separate request before acknowledging.
		var intent model.AgentDSHRequest
		require.NoError(t, model.DB.Where("user_id = ? AND session_id = ? AND request_id = ?", 41, session.SessionId, admissionRequestID).First(&intent).Error)
		assert.True(t, intent.CancelRequested)
		_, _ = io.WriteString(w, `{"version":1,"sessionId":"`+session.SessionId+`","requestId":"`+admissionRequestID+`","accepted":true,"status":"cancellation-requested","turn":3}`)
	}))
	defer server.Close()
	t.Setenv("LAIN42_DSH_BASE_URL", server.URL)
	t.Setenv("LAIN42_DSH_BRIDGE_SECRET", "test-only-cancellation-secret-with-32-bytes")
	for range 2 {
		response := sendDSHCancellation(t, 41, session.SessionId, admissionRequestID)
		assert.Equal(t, http.StatusAccepted, response.Code)
		assert.Contains(t, response.Body.String(), `"delivery":"received"`)
		assert.Contains(t, response.Body.String(), `"status":"cancellation-requested"`)
		assert.NotContains(t, response.Body.String(), `"settled"`)
		assert.NotContains(t, response.Body.String(), `"cancelled":true`)
	}
	assert.Equal(t, 2, calls, "lost receipts can be retried for the original target")
	owned, err := model.GetOwnedAgentDSHSession(41, session.SessionId)
	require.NoError(t, err)
	assert.Equal(t, 1, owned.RequestCount)
}

func TestCancelAgentDSHTurnDeliveryFailureKeepsIntentAndPreventsResubmission(t *testing.T) {
	setupAgentDSHControllerTest(t)
	gin.SetMode(gin.TestMode)
	session, err := model.CreateAgentDSHSession(41, time.Now().UTC())
	require.NoError(t, err)
	t.Setenv("LAIN42_DSH_BASE_URL", "")
	t.Setenv("LAIN42_DSH_BRIDGE_SECRET", "")
	response := sendDSHCancellation(t, 41, session.SessionId, admissionRequestID)
	assert.Equal(t, http.StatusAccepted, response.Code)
	assert.Contains(t, response.Body.String(), `"delivery":"pending"`)
	assert.NotContains(t, response.Body.String(), `"receipt"`)
	calls := configureAdmissionRuntime(t)
	turn := sendAdmissionTurn(t, 41, session.SessionId, admissionRequestID, t.Context())
	assert.Equal(t, http.StatusConflict, turn.Code)
	assert.Zero(t, *calls)
}

func TestCancelAgentDSHTurnRejectsForeignOwnersAndInvalidRequestBeforeDelivery(t *testing.T) {
	setupAgentDSHControllerTest(t)
	gin.SetMode(gin.TestMode)
	session, err := model.CreateAgentDSHSession(41, time.Now().UTC())
	require.NoError(t, err)
	calls := configureAdmissionRuntime(t)
	assert.Equal(t, http.StatusNotFound, sendDSHCancellation(t, 42, session.SessionId, admissionRequestID).Code)
	assert.Equal(t, http.StatusBadRequest, sendDSHCancellation(t, 41, session.SessionId, "not-a-uuid").Code)
	assert.Zero(t, *calls)
	owned, err := model.GetOwnedAgentDSHSession(41, session.SessionId)
	require.NoError(t, err)
	assert.Zero(t, owned.RequestCount)
}
