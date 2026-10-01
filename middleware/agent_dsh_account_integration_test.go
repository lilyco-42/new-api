package middleware_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/controller"
	"github.com/QuantumNous/new-api/dto"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func TestAgentDSHHTTPRoutesEnforceAuthenticatedSessionOwners(t *testing.T) {
	previousDB := model.DB
	previousDatabaseType := common.MainDatabaseType()
	previousRedisEnabled := common.RedisEnabled
	previousCookieSecure := common.SessionCookieSecure
	previousGinMode := gin.Mode()

	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	sqlDB, err := db.DB()
	require.NoError(t, err)
	sqlDB.SetMaxOpenConns(1)
	model.DB = db
	common.SetMainDatabaseType(common.DatabaseTypeSQLite)
	common.RedisEnabled = false
	common.SessionCookieSecure = false
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() {
		model.DB = previousDB
		common.SetMainDatabaseType(previousDatabaseType)
		common.RedisEnabled = previousRedisEnabled
		common.SessionCookieSecure = previousCookieSecure
		gin.SetMode(previousGinMode)
		_ = sqlDB.Close()
	})
	require.NoError(t, db.AutoMigrate(&model.User{}, &model.AgentDSHSession{}, &model.AgentDSHRequest{}))

	tokenA, tokenB := strings.Repeat("a", 32), strings.Repeat("b", 32)
	userA := &model.User{
		Username: "agent-dsh-http-a", Password: "password-placeholder",
		Role: common.RoleCommonUser, Status: common.UserStatusEnabled,
		Group: "default", AffCode: "agent-dsh-http-aff-a", AuthVersion: 1,
	}
	userA.SetAccessToken(tokenA)
	userB := &model.User{
		Username: "agent-dsh-http-b", Password: "password-placeholder",
		Role: common.RoleCommonUser, Status: common.UserStatusEnabled,
		Group: "default", AffCode: "agent-dsh-http-aff-b", AuthVersion: 1,
	}
	userB.SetAccessToken(tokenB)
	require.NoError(t, db.Create(userA).Error)
	require.NoError(t, db.Create(userB).Error)

	var (
		runtimeMu       sync.Mutex
		runtimeSessions []string
		runtimeErr      error
	)
	runtime := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost || request.URL.Path != "/lain42/bridge/v1/turn" || request.Header.Get("X-Lain42-Signature") == "" {
			runtimeMu.Lock()
			runtimeErr = fmt.Errorf("unexpected DSH request: %s %s", request.Method, request.URL.Path)
			runtimeMu.Unlock()
			http.Error(writer, "unexpected request", http.StatusBadRequest)
			return
		}
		var forwarded struct {
			SessionID string `json:"sessionId"`
			RequestID string `json:"requestId"`
		}
		if err := json.NewDecoder(request.Body).Decode(&forwarded); err != nil {
			runtimeMu.Lock()
			runtimeErr = fmt.Errorf("decode forwarded turn: %w", err)
			runtimeMu.Unlock()
			http.Error(writer, "invalid request", http.StatusBadRequest)
			return
		}
		runtimeMu.Lock()
		runtimeSessions = append(runtimeSessions, forwarded.SessionID)
		runtimeMu.Unlock()
		writer.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(writer, `{"version":1,"requestId":%q,"answer":%q}`, forwarded.RequestID, "answer for "+forwarded.SessionID)
	}))
	defer runtime.Close()
	forwardedSessions := func() []string {
		runtimeMu.Lock()
		defer runtimeMu.Unlock()
		return append([]string(nil), runtimeSessions...)
	}
	forwardingError := func() error {
		runtimeMu.Lock()
		defer runtimeMu.Unlock()
		return runtimeErr
	}
	t.Setenv("LAIN42_DSH_BASE_URL", runtime.URL)
	t.Setenv("LAIN42_DSH_BRIDGE_SECRET", strings.Repeat("s", 32))

	router := gin.New()
	router.POST("/api/agent/dsh/sessions", middleware.UserAuth(), middleware.SessionCookieOriginGuard(), controller.CreateAgentDSHSession)
	router.POST("/api/agent/dsh/turns", middleware.UserAuth(), middleware.SessionCookieOriginGuard(), controller.AgentDSHTurn)

	createSession := func(token string) string {
		request := httptest.NewRequest(http.MethodPost, "/api/agent/dsh/sessions", nil)
		request.Header.Set("Authorization", "Bearer "+token)
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		require.Equal(t, http.StatusOK, response.Code, response.Body.String())
		var envelope struct {
			Success bool `json:"success"`
			Data    struct {
				SessionID string `json:"session_id"`
			} `json:"data"`
		}
		require.NoError(t, json.Unmarshal(response.Body.Bytes(), &envelope))
		require.True(t, envelope.Success)
		require.Len(t, envelope.Data.SessionID, model.AgentDSHSessionIDBytes*2)
		return envelope.Data.SessionID
	}

	sessionA := createSession(tokenA)
	sessionB := createSession(tokenB)
	require.NotEqual(t, sessionA, sessionB)

	sendTurn := func(token, sessionID, requestID string) *httptest.ResponseRecorder {
		body, marshalErr := json.Marshal(dto.AgentDSHTurnRequest{
			SessionID: sessionID,
			RequestID: requestID,
			Model:     "openai/gpt-5.6-sol",
			Mode:      "general",
			Text:      "hello",
		})
		require.NoError(t, marshalErr)
		request := httptest.NewRequest(http.MethodPost, "/api/agent/dsh/turns", strings.NewReader(string(body)))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Authorization", "Bearer "+token)
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		return response
	}

	requestID := "123e4567-e89b-42d3-a456-426614174000"
	response := sendTurn(tokenB, sessionA, requestID)
	require.Equal(t, http.StatusNotFound, response.Code, response.Body.String())
	require.NoError(t, forwardingError())
	require.Empty(t, forwardedSessions(), "a foreign account must be rejected before calling DSH")

	response = sendTurn(tokenA, sessionA, requestID)
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	require.Contains(t, response.Body.String(), "answer for "+sessionA)
	_, err = model.RequestOwnedAgentDSHCancellation(userA.Id, sessionA, requestID, time.Now().UTC())
	require.NoError(t, err)
	response = sendTurn(tokenA, sessionA, requestID)
	require.Equal(t, http.StatusConflict, response.Code, response.Body.String())
	require.Contains(t, response.Body.String(), "AGENT_DSH_CANCEL_REQUESTED")
	require.Equal(t, []string{sessionA}, forwardedSessions(), "a canceled identity must not be resubmitted through the authenticated route")

	response = sendTurn(tokenA, sessionB, "123e4567-e89b-42d3-a456-426614174001")
	require.Equal(t, http.StatusNotFound, response.Code, response.Body.String())

	// Reusing the same UUID in a different owned session is independent of A's Stop.
	response = sendTurn(tokenB, sessionB, requestID)
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	require.Contains(t, response.Body.String(), "answer for "+sessionB)
	require.NoError(t, forwardingError())
	require.Equal(t, []string{sessionA, sessionB}, forwardedSessions())
}
