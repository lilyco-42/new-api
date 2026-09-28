package controller

import (
	"bytes"
	"crypto/hmac"
	"crypto/rand"
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
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

const agentToolRelayTestSecret = "test-lain42-dsh-bridge-secret-long-enough"

type agentToolRelayRoundTripper func(*http.Request) (*http.Response, error)

func (roundTrip agentToolRelayRoundTripper) RoundTrip(request *http.Request) (*http.Response, error) {
	return roundTrip(request)
}

func setupAgentToolRelayTest(t *testing.T) {
	t.Helper()
	previousDB := model.DB
	previousCryptoSecret := common.CryptoSecret
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	sqlDB, err := db.DB()
	require.NoError(t, err)
	sqlDB.SetMaxOpenConns(1)
	model.DB = db
	common.CryptoSecret = "agent-tool-relay-test-crypto-secret"
	require.NoError(t, model.DB.AutoMigrate(&model.AgentWebSession{}, &model.AgentModelRelayNonce{}, &model.AgentGitHubCredential{}))
	t.Setenv(service.AgentDSHBridgeSecretEnv, agentToolRelayTestSecret)
	previousMode := gin.Mode()
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() {
		model.DB = previousDB
		common.CryptoSecret = previousCryptoSecret
		gin.SetMode(previousMode)
		_ = sqlDB.Close()
	})
}

func TestAgentDSHToolRelayUsesOAuthCredentialBoundToStoredSessionOwner(t *testing.T) {
	setupAgentToolRelayTest(t)
	userSeven, err := model.CreateAgentWebSession(7)
	require.NoError(t, err)
	_, err = model.CreateAgentWebSession(8)
	require.NoError(t, err)
	require.NoError(t, model.SaveAgentGitHubCredential(7, "gh-user-7", "user-seven", "repo", "token-seven"))
	require.NoError(t, model.SaveAgentGitHubCredential(8, "gh-user-8", "user-eight", "repo", "token-eight"))

	previousTransport := http.DefaultTransport
	var authorization string
	http.DefaultTransport = agentToolRelayRoundTripper(func(request *http.Request) (*http.Response, error) {
		authorization = request.Header.Get("Authorization")
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     make(http.Header),
			Body:       io.NopCloser(strings.NewReader(`[{"full_name":"user-seven/private-repo","html_url":"https://github.com/user-seven/private-repo","stargazers_count":2,"private":true}]`)),
		}, nil
	})
	t.Cleanup(func() { http.DefaultTransport = previousTransport })

	recorder := invokeAgentToolRelay(t, map[string]any{
		"version": 1, "session_id": userSeven.DshSessionId, "tool": "github_repositories", "arguments": map[string]any{"limit": 3},
	})
	require.Equal(t, http.StatusOK, recorder.Code)
	assert.Equal(t, "Bearer token-seven", authorization)
	assert.Contains(t, recorder.Body.String(), "user-seven/private-repo")
	assert.NotContains(t, recorder.Body.String(), "token-seven")
	assert.NotContains(t, recorder.Body.String(), "token-eight")
}

func TestAgentDSHToolRelayRejectsReplayAndUntrustedIdentityFields(t *testing.T) {
	setupAgentToolRelayTest(t)
	session, err := model.CreateAgentWebSession(7)
	require.NoError(t, err)
	request := map[string]any{
		"version": 1, "session_id": session.DshSessionId, "tool": "unknown_tool", "arguments": map[string]any{},
	}
	body, err := common.Marshal(request)
	require.NoError(t, err)
	nonce := randomAgentToolRelayNonce(t)
	recorder := invokeSignedAgentToolRelay(t, body, nonce)
	require.Equal(t, http.StatusOK, recorder.Code)

	replay := invokeSignedAgentToolRelay(t, body, nonce)
	assert.Equal(t, http.StatusUnauthorized, replay.Code)

	request["user_id"] = 8
	forgedBody, err := common.Marshal(request)
	require.NoError(t, err)
	forged := invokeSignedAgentToolRelay(t, forgedBody, randomAgentToolRelayNonce(t))
	assert.Equal(t, http.StatusBadRequest, forged.Code)
}

func TestAgentDSHToolRelayReportsOAuthRequirementAndBlocksPrivateFetchTargets(t *testing.T) {
	setupAgentToolRelayTest(t)
	session, err := model.CreateAgentWebSession(7)
	require.NoError(t, err)
	github := invokeAgentToolRelay(t, map[string]any{
		"version": 1, "session_id": session.DshSessionId, "tool": "github_repositories", "arguments": map[string]any{},
	})
	require.Equal(t, http.StatusOK, github.Code)
	assert.Contains(t, github.Body.String(), "github_not_connected")
	assert.Contains(t, github.Body.String(), "Connect GitHub in this website account")

	fetch := invokeAgentToolRelay(t, map[string]any{
		"version": 1, "session_id": session.DshSessionId, "tool": "web_fetch", "arguments": map[string]any{"url": "http://127.0.0.1/secret"},
	})
	require.Equal(t, http.StatusOK, fetch.Code)
	assert.Contains(t, fetch.Body.String(), "url_not_allowed")
}

func TestAgentDSHToolRelayRejectsRepositoryPathTraversal(t *testing.T) {
	setupAgentToolRelayTest(t)
	session, err := model.CreateAgentWebSession(7)
	require.NoError(t, err)
	require.NoError(t, model.SaveAgentGitHubCredential(7, "gh-user-7", "user-seven", "repo", "token-seven"))

	recorder := invokeAgentToolRelay(t, map[string]any{
		"version":    1,
		"session_id": session.DshSessionId,
		"tool":       "github_issues",
		"arguments":  map[string]any{"repo": "owner/../private", "limit": 1},
	})

	require.Equal(t, http.StatusOK, recorder.Code)
	assert.Contains(t, recorder.Body.String(), "invalid_arguments")
	assert.Contains(t, recorder.Body.String(), "owner/name")
}

func invokeAgentToolRelay(t *testing.T, body any) *httptest.ResponseRecorder {
	t.Helper()
	bytes, err := common.Marshal(body)
	require.NoError(t, err)
	return invokeSignedAgentToolRelay(t, bytes, randomAgentToolRelayNonce(t))
}

func invokeSignedAgentToolRelay(t *testing.T, body []byte, nonce string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, service.AgentDSHToolRelayPath, bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	timestamp := fmt.Sprint(time.Now().UTC().Unix())
	request.Header.Set("X-Lain42-Timestamp", timestamp)
	request.Header.Set("X-Lain42-Nonce", nonce)
	request.Header.Set("X-Lain42-Signature", signAgentToolRelayTestRequest(agentToolRelayTestSecret, timestamp, nonce, body))
	recorder := httptest.NewRecorder()
	context, _ := gin.CreateTestContext(recorder)
	context.Request = request
	AgentDSHToolRelay(context)
	return recorder
}

func signAgentToolRelayTestRequest(secret, timestamp, nonce string, body []byte) string {
	digest := sha256.Sum256(body)
	canonical := fmt.Sprintf("v1\n%s\n%s\nPOST\n%s\n%s", timestamp, nonce, service.AgentDSHToolRelayPath, hex.EncodeToString(digest[:]))
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(canonical))
	return hex.EncodeToString(mac.Sum(nil))
}

func randomAgentToolRelayNonce(t *testing.T) string {
	t.Helper()
	entropy := make([]byte, 16)
	_, err := rand.Read(entropy)
	require.NoError(t, err)
	return hex.EncodeToString(entropy)
}
