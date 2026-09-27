package controller

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func setupAgentWebSessionControllerTest(t *testing.T) {
	t.Helper()
	previousDB := model.DB
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	sqlDB, err := db.DB()
	require.NoError(t, err)
	sqlDB.SetMaxOpenConns(1)
	model.DB = db
	require.NoError(t, model.DB.AutoMigrate(&model.AgentWebSession{}))
	t.Cleanup(func() {
		model.DB = previousDB
		_ = sqlDB.Close()
	})
}

func TestCreateAgentWebSessionUsesAuthenticatedIdentityAndRejectsClientFields(t *testing.T) {
	setupAgentWebSessionControllerTest(t)
	previousGinMode := gin.Mode()
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() { gin.SetMode(previousGinMode) })

	recorder := httptest.NewRecorder()
	context, _ := gin.CreateTestContext(recorder)
	context.Request = httptest.NewRequest("POST", "/api/agent/sessions", nil)
	context.Set("id", 7)
	CreateAgentWebSession(context)
	require.Equal(t, 200, recorder.Code)

	var envelope struct {
		Data struct {
			SessionID string `json:"session_id"`
		} `json:"data"`
	}
	require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &envelope))
	require.Len(t, envelope.Data.SessionID, 64)
	var persisted model.AgentWebSession
	require.NoError(t, model.DB.Where("public_session_id = ?", envelope.Data.SessionID).First(&persisted).Error)
	require.Equal(t, 7, persisted.UserId)
	require.NotContains(t, recorder.Body.String(), persisted.DshSessionId)
	require.NotContains(t, recorder.Body.String(), "user_id")

	forgedRecorder := httptest.NewRecorder()
	forgedContext, _ := gin.CreateTestContext(forgedRecorder)
	forgedContext.Request = httptest.NewRequest("POST", "/api/agent/sessions", strings.NewReader(`{"user_id":8,"dsh_session_id":"chosen","cwd":"/"}`))
	forgedContext.Set("id", 7)
	CreateAgentWebSession(forgedContext)
	require.Equal(t, 400, forgedRecorder.Code)
	var count int64
	require.NoError(t, model.DB.Model(&model.AgentWebSession{}).Count(&count).Error)
	require.EqualValues(t, 1, count)
}

func TestSubmitAgentWebTurnUsesOwnedPrivateDSHSessionAndSignedBridge(t *testing.T) {
	setupAgentWebSessionControllerTest(t)
	previousGinMode := gin.Mode()
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() { gin.SetMode(previousGinMode) })
	secret := "0123456789abcdef0123456789abcdef"
	t.Setenv(service.AgentDSHBridgeSecretEnv, secret)
	session, err := model.CreateAgentWebSession(7)
	require.NoError(t, err)
	bridgeRequestIDs := make([]string, 0, 2)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		if request.Method != http.MethodPost || request.URL.Path != service.AgentDSHBridgePath {
			http.Error(writer, "bad route", http.StatusNotFound)
			return
		}
		body, readErr := io.ReadAll(request.Body)
		if readErr != nil {
			t.Errorf("read DSH request: %v", readErr)
			http.Error(writer, "bad request", http.StatusBadRequest)
			return
		}
		if got := verifyAgentDSHBridgeSignature(request, secret, body); !got {
			t.Errorf("DSH bridge request signature was invalid")
			http.Error(writer, "unauthorized", http.StatusUnauthorized)
			return
		}
		var payload struct {
			Version   int    `json:"version"`
			SessionID string `json:"sessionId"`
			RequestID string `json:"requestId"`
			Model     string `json:"model"`
			Text      string `json:"text"`
		}
		if err := common.Unmarshal(body, &payload); err != nil {
			t.Errorf("decode DSH request: %v", err)
			http.Error(writer, "bad request", http.StatusBadRequest)
			return
		}
		if payload.Version != 1 || payload.SessionID != session.DshSessionId || payload.Text != "Explain Rust ownership" || payload.Model != "openai/gpt-5.6-sol" || len(payload.RequestID) != 36 {
			t.Errorf("unexpected private DSH payload: %+v", payload)
			http.Error(writer, "bad request", http.StatusBadRequest)
			return
		}
		bridgeRequestIDs = append(bridgeRequestIDs, payload.RequestID)
		if strings.Contains(string(body), session.PublicSessionId) || strings.Contains(string(body), "user_id") {
			t.Errorf("private bridge body exposed browser or account identifiers")
			http.Error(writer, "bad request", http.StatusBadRequest)
			return
		}
		response, marshalErr := common.Marshal(map[string]any{"version": 1, "requestId": payload.RequestID, "answer": "Rust ownership manages value lifetimes."})
		if marshalErr != nil {
			t.Errorf("encode DSH response: %v", marshalErr)
			http.Error(writer, "server error", http.StatusInternalServerError)
			return
		}
		_, _ = writer.Write(response)
	}))
	defer server.Close()
	t.Setenv(service.AgentDSHBridgeURLEnv, server.URL+service.AgentDSHBridgePath)

	body := `{"session_id":"` + session.PublicSessionId + `","request_id":"message-key-001","model":"openai/gpt-5.6-sol","text":"Explain Rust ownership"}`
	recorder := submitAgentWebTurnForUser(7, body)
	require.Equal(t, http.StatusOK, recorder.Code)
	var envelope struct {
		Data struct {
			RequestID string `json:"request_id"`
			Answer    string `json:"answer"`
		} `json:"data"`
	}
	require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &envelope))
	require.Len(t, envelope.Data.RequestID, 36)
	require.Equal(t, "Rust ownership manages value lifetimes.", envelope.Data.Answer)
	require.NotContains(t, recorder.Body.String(), session.DshSessionId)

	retry := submitAgentWebTurnForUser(7, body)
	require.Equal(t, http.StatusOK, retry.Code)
	require.Len(t, bridgeRequestIDs, 2)
	require.Equal(t, bridgeRequestIDs[0], bridgeRequestIDs[1], "same browser message key must be idempotent at the DSH boundary")
}

func TestSubmitAgentWebTurnRejectsCrossAccountAndRevokedSessionsBeforeBridge(t *testing.T) {
	setupAgentWebSessionControllerTest(t)
	previousGinMode := gin.Mode()
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() { gin.SetMode(previousGinMode) })
	session, err := model.CreateAgentWebSession(7)
	require.NoError(t, err)
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		calls.Add(1)
		http.Error(writer, "must not be called", http.StatusInternalServerError)
	}))
	defer server.Close()
	t.Setenv(service.AgentDSHBridgeURLEnv, server.URL+service.AgentDSHBridgePath)
	t.Setenv(service.AgentDSHBridgeSecretEnv, "0123456789abcdef0123456789abcdef")
	body := `{"session_id":"` + session.PublicSessionId + `","text":"hello"}`
	require.Equal(t, http.StatusNotFound, submitAgentWebTurnForUser(8, body).Code)
	require.NoError(t, model.RevokeAgentWebSession(7, session.PublicSessionId, time.Now().UTC()))
	require.Equal(t, http.StatusNotFound, submitAgentWebTurnForUser(7, body).Code)
	require.Zero(t, calls.Load())
}

func TestSubmitAgentWebTurnRejectsUnknownFieldsAndReportsMissingBridgeConfig(t *testing.T) {
	setupAgentWebSessionControllerTest(t)
	previousGinMode := gin.Mode()
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() { gin.SetMode(previousGinMode) })
	t.Setenv(service.AgentDSHBridgeURLEnv, "")
	t.Setenv(service.AgentDSHBridgeSecretEnv, "")
	unknownField := submitAgentWebTurnForUser(7, `{"session_id":"`+strings.Repeat("a", 64)+`","text":"hello","user_id":8}`)
	require.Equal(t, http.StatusBadRequest, unknownField.Code)

	session, err := model.CreateAgentWebSession(7)
	require.NoError(t, err)
	missingConfig := submitAgentWebTurnForUser(7, `{"session_id":"`+session.PublicSessionId+`","text":"hello"}`)
	require.Equal(t, http.StatusServiceUnavailable, missingConfig.Code)
	require.Contains(t, missingConfig.Body.String(), "AGENT_TURN_UNAVAILABLE")
	t.Setenv(service.AgentDSHBridgeURLEnv, "http://example.com"+service.AgentDSHBridgePath)
	t.Setenv(service.AgentDSHBridgeSecretEnv, "0123456789abcdef0123456789abcdef")
	insecureEndpoint := submitAgentWebTurnForUser(7, `{"session_id":"`+session.PublicSessionId+`","text":"hello"}`)
	require.Equal(t, http.StatusServiceUnavailable, insecureEndpoint.Code)
}

func submitAgentWebTurnForUser(userID int, body string) *httptest.ResponseRecorder {
	recorder := httptest.NewRecorder()
	context, _ := gin.CreateTestContext(recorder)
	context.Request = httptest.NewRequest(http.MethodPost, "/api/agent/turns", strings.NewReader(body))
	context.Request.Header.Set("Content-Type", "application/json")
	context.Set("id", userID)
	SubmitAgentWebTurn(context)
	return recorder
}

func verifyAgentDSHBridgeSignature(request *http.Request, secret string, body []byte) bool {
	timestamp := request.Header.Get("X-Lain42-Timestamp")
	nonce := request.Header.Get("X-Lain42-Nonce")
	signature := request.Header.Get("X-Lain42-Signature")
	digest := sha256.Sum256(body)
	canonical := fmt.Sprintf("v1\n%s\n%s\nPOST\n%s\n%s", timestamp, nonce, service.AgentDSHBridgePath, hex.EncodeToString(digest[:]))
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(canonical))
	expected := mac.Sum(nil)
	actual, err := hex.DecodeString(signature)
	return err == nil && hmac.Equal(expected, actual)
}

func TestRevokeAgentWebSessionIsScopedToAuthenticatedIdentity(t *testing.T) {
	setupAgentWebSessionControllerTest(t)
	previousGinMode := gin.Mode()
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() { gin.SetMode(previousGinMode) })
	owned, err := model.CreateAgentWebSession(7)
	require.NoError(t, err)

	recorder := httptest.NewRecorder()
	context, _ := gin.CreateTestContext(recorder)
	context.Request = httptest.NewRequest("DELETE", "/api/agent/sessions/"+owned.PublicSessionId, nil)
	context.Params = gin.Params{{Key: "id", Value: owned.PublicSessionId}}
	context.Set("id", 8)
	RevokeAgentWebSession(context)
	require.Equal(t, 404, recorder.Code)
	_, err = model.ResolveAgentWebSession(7, owned.PublicSessionId)
	require.NoError(t, err)
}
