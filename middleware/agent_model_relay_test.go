package middleware

import (
	"bytes"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func signedAgentModelRelayRequest(t *testing.T, secret, sessionID, modelName, nonce string, bodyModel string, now time.Time) *http.Request {
	t.Helper()
	timestamp := strconv.FormatInt(now.Unix(), 10)
	body := []byte(fmt.Sprintf(`{"model":%q,"messages":[{"role":"user","content":"hi"}]}`, bodyModel))
	request := httptest.NewRequest(http.MethodPost, AgentModelRelayPath, bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Lain42-Agent-Session", sessionID)
	request.Header.Set("X-Lain42-Agent-Model", modelName)
	request.Header.Set("X-Lain42-Timestamp", timestamp)
	request.Header.Set("X-Lain42-Nonce", nonce)
	request.Header.Set("X-Lain42-Signature", SignAgentModelRelayRequest(secret, timestamp, nonce, sessionID, modelName))
	return request
}

func TestAgentModelRelayAuthenticatesOwnerAndReusesPlaygroundPath(t *testing.T) {
	setupDashboardAuthMiddlewareTest(t)
	require.NoError(t, model.DB.AutoMigrate(&model.AgentWebSession{}, &model.AgentModelRelayNonce{}))
	user := createMiddlewarePATUser(t, "agent-relay-owner", "relay-test-token")
	session, err := model.CreateAgentWebSession(user.Id)
	require.NoError(t, err)
	secret := "0123456789abcdef0123456789abcdef"
	t.Setenv(AgentModelRelaySecretEnv, secret)
	previousGinMode := gin.Mode()
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() { gin.SetMode(previousGinMode) })

	router := gin.New()
	router.POST(AgentModelRelayPath, AgentModelRelayAuth(), func(c *gin.Context) {
		require.Equal(t, user.Id, c.GetInt("id"))
		require.Equal(t, "/pg/chat/completions", c.Request.URL.Path)
		c.Status(http.StatusNoContent)
	})
	now := time.Now().UTC().Truncate(time.Second)
	nonce := "abcdef0123456789abcdef0123456789"
	request := signedAgentModelRelayRequest(t, secret, session.DshSessionId, "deepseek-chat", nonce, "deepseek-chat", now)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	require.Equal(t, http.StatusNoContent, response.Code)

	replay := signedAgentModelRelayRequest(t, secret, session.DshSessionId, "deepseek-chat", nonce, "deepseek-chat", now)
	replayResponse := httptest.NewRecorder()
	router.ServeHTTP(replayResponse, replay)
	require.Equal(t, http.StatusUnauthorized, replayResponse.Code)
}

func TestAgentModelRelayRejectsForgedModelAndUnknownSession(t *testing.T) {
	setupDashboardAuthMiddlewareTest(t)
	require.NoError(t, model.DB.AutoMigrate(&model.AgentWebSession{}, &model.AgentModelRelayNonce{}))
	user := createMiddlewarePATUser(t, "agent-relay-owner-two", "relay-test-token-two")
	session, err := model.CreateAgentWebSession(user.Id)
	require.NoError(t, err)
	secret := "0123456789abcdef0123456789abcdef"
	t.Setenv(AgentModelRelaySecretEnv, secret)
	previousGinMode := gin.Mode()
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() { gin.SetMode(previousGinMode) })
	router := gin.New()
	router.POST(AgentModelRelayPath, AgentModelRelayAuth(), func(c *gin.Context) { c.Status(http.StatusNoContent) })
	now := time.Now().UTC().Truncate(time.Second)

	forgedModel := signedAgentModelRelayRequest(t, secret, session.DshSessionId, "deepseek-chat", "0123456789abcdef0123456789abcdef", "other-model", now)
	forgedModelResponse := httptest.NewRecorder()
	router.ServeHTTP(forgedModelResponse, forgedModel)
	require.Equal(t, http.StatusUnauthorized, forgedModelResponse.Code)

	unknownSession := signedAgentModelRelayRequest(t, secret, "z"+session.DshSessionId[1:], "deepseek-chat", "fedcba9876543210fedcba9876543210", "deepseek-chat", now)
	unknownSessionResponse := httptest.NewRecorder()
	router.ServeHTTP(unknownSessionResponse, unknownSession)
	require.Equal(t, http.StatusUnauthorized, unknownSessionResponse.Code)
}

func TestAgentModelRelayFailsClosedWithoutSecret(t *testing.T) {
	t.Setenv(AgentModelRelaySecretEnv, "")
	previousGinMode := gin.Mode()
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() { gin.SetMode(previousGinMode) })
	router := gin.New()
	router.POST(AgentModelRelayPath, AgentModelRelayAuth(), func(c *gin.Context) { c.Status(http.StatusNoContent) })
	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodPost, AgentModelRelayPath, bytes.NewBufferString(`{"model":"m"}`)))
	require.Equal(t, http.StatusServiceUnavailable, response.Code)
}
