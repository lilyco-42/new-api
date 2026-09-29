package controller

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
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
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func setupAgentDSHControllerTest(t *testing.T) {
	t.Helper()
	previousDB := model.DB
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	sqlDB, err := db.DB()
	require.NoError(t, err)
	sqlDB.SetMaxOpenConns(1)
	model.DB = db
	require.NoError(t, model.DB.AutoMigrate(&model.AgentDSHSession{}))
	t.Cleanup(func() {
		model.DB = previousDB
		_ = sqlDB.Close()
	})
}

func TestConfiguredAgentDSHEndpointRequiresTrustedTransportAndOriginOnly(t *testing.T) {
	t.Setenv("LAIN42_DSH_BASE_URL", "https://dsh.example.com")
	endpoint, err := configuredAgentDSHEndpoint(agentDSHTurnPath)
	require.NoError(t, err)
	assert.Equal(t, "https://dsh.example.com/lain42/bridge/v1/turn", endpoint)

	t.Setenv("LAIN42_DSH_BASE_URL", "http://127.0.0.1:8787")
	endpoint, err = configuredAgentDSHEndpoint(agentDSHTurnPath)
	require.NoError(t, err)
	assert.Equal(t, "http://127.0.0.1:8787/lain42/bridge/v1/turn", endpoint)

	for _, raw := range []string{
		"http://dsh.example.com",
		"https://user@dsh.example.com",
		"https://dsh.example.com/private/path",
		"https://dsh.example.com?target=internal",
	} {
		t.Setenv("LAIN42_DSH_BASE_URL", raw)
		_, err := configuredAgentDSHEndpoint(agentDSHTurnPath)
		assert.Error(t, err, raw)
	}
}

func TestAgentDSHTurnUsesSignedPrivateRuntimeAndChecksSessionOwner(t *testing.T) {
	setupAgentDSHControllerTest(t)
	gin.SetMode(gin.TestMode)
	const userID = 41
	secret := "0123456789abcdef0123456789abcdef"
	session, err := model.CreateAgentDSHSession(userID, time.Now().UTC())
	require.NoError(t, err)
	t.Setenv("LAIN42_DSH_BRIDGE_SECRET", secret)

	called := false
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		called = true
		assert.Equal(t, http.MethodPost, request.Method)
		assert.Equal(t, agentDSHTurnPath, request.URL.Path)
		body, readErr := io.ReadAll(request.Body)
		require.NoError(t, readErr)
		timestamp := request.Header.Get("X-Lain42-Timestamp")
		nonce := request.Header.Get("X-Lain42-Nonce")
		digest := sha256.Sum256(body)
		canonical := fmt.Sprintf("v1\n%s\n%s\nPOST\n%s\n%s", timestamp, nonce, agentDSHTurnPath, hex.EncodeToString(digest[:]))
		expected := common.GenerateHMACWithKey([]byte(secret), canonical)
		assert.Equal(t, expected, request.Header.Get("X-Lain42-Signature"))
		var forwarded agentDSHWireTurnRequest
		require.NoError(t, common.Unmarshal(body, &forwarded))
		assert.Equal(t, session.SessionId, forwarded.SessionID)
		assert.Equal(t, "hello from browser", forwarded.Text)
		assert.NotContains(t, string(body), "user_id")
		writer.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(writer, `{"version":1,"requestId":"123e4567-e89b-42d3-a456-426614174000","answer":"grounded response"}`)
	}))
	defer server.Close()
	t.Setenv("LAIN42_DSH_BASE_URL", server.URL)

	requestBody, err := common.Marshal(dto.AgentDSHTurnRequest{
		SessionID: session.SessionId,
		RequestID: "123e4567-e89b-42d3-a456-426614174000",
		Model:     "openai/gpt-5.6-sol",
		Text:      "hello from browser",
	})
	require.NoError(t, err)
	response := httptest.NewRecorder()
	context, _ := gin.CreateTestContext(response)
	context.Request = httptest.NewRequest(http.MethodPost, "/api/agent/dsh/turns", strings.NewReader(string(requestBody)))
	context.Request.Header.Set("Content-Type", "application/json")
	context.Set("id", userID)
	AgentDSHTurn(context)
	assert.True(t, called)
	assert.Equal(t, http.StatusOK, response.Code)
	assert.Contains(t, response.Body.String(), "grounded response")

	called = false
	response = httptest.NewRecorder()
	context, _ = gin.CreateTestContext(response)
	context.Request = httptest.NewRequest(http.MethodPost, "/api/agent/dsh/turns", strings.NewReader(string(requestBody)))
	context.Request.Header.Set("Content-Type", "application/json")
	context.Set("id", userID+1)
	AgentDSHTurn(context)
	assert.False(t, called, "another account must not proxy an owned session")
	assert.Equal(t, http.StatusNotFound, response.Code)
}

func TestAgentDSHTurnRejectsOversizedBodyBeforeBuffering(t *testing.T) {
	gin.SetMode(gin.TestMode)
	body := `{"text":"x"}` + strings.Repeat(" ", agentDSHTurnBodyLimit)
	request := httptest.NewRequest(http.MethodPost, "/api/agent/dsh/turns", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	context, _ := gin.CreateTestContext(response)
	context.Request = request
	context.Set("id", 42)

	AgentDSHTurn(context)

	assert.Equal(t, http.StatusRequestEntityTooLarge, response.Code)
}

func TestAgentDSHToolRelayDoesNotExposeUnsupportedToolsAsSuccess(t *testing.T) {
	gin.SetMode(gin.TestMode)
	result, code, message := executeAgentDSHTool(nil, "github_actions_logs", map[string]any{"job_id": float64(2)})
	assert.Nil(t, result)
	assert.Equal(t, "tool_not_available", code)
	assert.NotEmpty(t, message)
}
