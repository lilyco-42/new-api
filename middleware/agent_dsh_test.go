package middleware

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func TestAgentDSHModelSignatureBindsSessionModelAndTime(t *testing.T) {
	secret := "0123456789abcdef0123456789abcdef"
	now := time.Date(2026, time.September, 29, 12, 0, 0, 0, time.UTC)
	timestamp := fmt.Sprintf("%d", now.Unix())
	nonce := "0123456789abcdef0123456789abcdef"
	sessionID := "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	modelName := "openai/gpt-5.6-sol"
	canonical := fmt.Sprintf("v1\n%s\n%s\nPOST\n%s\n%s\n%s", timestamp, nonce, agentDSHModelRelayPath, sessionID, modelName)
	signature := common.GenerateHMACWithKey([]byte(secret), canonical)

	assert.True(t, verifyAgentDSHModelSignature(secret, timestamp, nonce, signature, sessionID, modelName, now))
	assert.False(t, verifyAgentDSHModelSignature(secret, timestamp, nonce, signature, sessionID+"a", modelName, now))
	assert.False(t, verifyAgentDSHModelSignature(secret, timestamp, nonce, signature, sessionID, "anthropic/claude", now))
	assert.False(t, verifyAgentDSHModelSignature(secret, timestamp, nonce, signature, sessionID, modelName, now.Add(agentDSHAuthWindow+time.Second)))
	assert.False(t, verifyAgentDSHModelSignature(secret, timestamp, "not-a-nonce", signature, sessionID, modelName, now))
}

func TestAgentDSHToolSignatureCoversExactBodyAndRejectsOldOrMalformedAuth(t *testing.T) {
	secret := "0123456789abcdef0123456789abcdef"
	now := time.Date(2026, time.September, 29, 12, 0, 0, 0, time.UTC)
	timestamp := fmt.Sprintf("%d", now.Unix())
	nonce := "fedcba9876543210fedcba9876543210"
	body := []byte(`{"version":1,"session_id":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","tool":"web_search","arguments":{"query":"rust"}}`)
	digest := sha256.Sum256(body)
	canonical := fmt.Sprintf("v1\n%s\n%s\nPOST\n%s\n%s", timestamp, nonce, agentDSHToolRelayPath, hex.EncodeToString(digest[:]))
	signature := common.GenerateHMACWithKey([]byte(secret), canonical)

	require.True(t, verifyAgentDSHToolSignature(secret, body, timestamp, nonce, signature, now))
	assert.False(t, verifyAgentDSHToolSignature(secret, append(body, ' '), timestamp, nonce, signature, now))
	assert.False(t, verifyAgentDSHToolSignature(secret, body, timestamp, nonce, signature, now.Add(-agentDSHAuthWindow-time.Second)))
	assert.False(t, verifyAgentDSHToolSignature(secret, body, timestamp, "ABCDEF", signature, now))
}

func setupAgentDSHMiddlewareTest(t *testing.T) {
	t.Helper()
	previousDB := model.DB
	previousType := common.MainDatabaseType()
	previousRedis := common.RedisEnabled
	previousSecret := common.SessionSecret
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	sqlDB, err := db.DB()
	require.NoError(t, err)
	sqlDB.SetMaxOpenConns(1)
	model.DB = db
	common.SetMainDatabaseType(common.DatabaseTypeSQLite)
	common.RedisEnabled = false
	common.SessionSecret = "agent-dsh-middleware-test-secret"
	require.NoError(t, db.AutoMigrate(&model.User{}, &model.AgentDSHSession{}, &model.AuthFlow{}))
	t.Cleanup(func() {
		model.DB = previousDB
		common.SetMainDatabaseType(previousType)
		common.RedisEnabled = previousRedis
		common.SessionSecret = previousSecret
		_ = sqlDB.Close()
	})
}

func createAgentDSHTestUser(t *testing.T, username string) *model.User {
	t.Helper()
	user := &model.User{
		Username: username, Password: "password-placeholder", Role: common.RoleCommonUser,
		Status: common.UserStatusEnabled, Group: "default", AuthVersion: 1,
		AffCode: "agent-dsh-" + username,
	}
	require.NoError(t, model.DB.Create(user).Error)
	return user
}

func TestAgentDSHModelAuthBindsRelayToOwnedSessionAndRejectsReplay(t *testing.T) {
	setupAgentDSHMiddlewareTest(t)
	gin.SetMode(gin.TestMode)
	secret := "0123456789abcdef0123456789abcdef"
	t.Setenv("LAIN42_AGENT_MODEL_RELAY_SECRET", secret)
	userOne := createAgentDSHTestUser(t, "agent-dsh-model-one")
	userTwo := createAgentDSHTestUser(t, "agent-dsh-model-two")
	sessionOne, err := model.CreateAgentDSHSession(userOne.Id, time.Now().UTC())
	require.NoError(t, err)
	sessionTwo, err := model.CreateAgentDSHSession(userTwo.Id, time.Now().UTC())
	require.NoError(t, err)
	modelName := "openai/gpt-5.6-sol"
	body := `{"model":"openai/gpt-5.6-sol","messages":[{"role":"user","content":"hello"}]}`
	router := gin.New()
	router.POST(agentDSHModelRelayPath, AgentDSHModelAuth(), func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{
			"id":    c.GetInt("id"),
			"group": common.GetContextKeyString(c, constant.ContextKeyUsingGroup),
		})
	})
	makeRequest := func(sessionID, nonce string) *httptest.ResponseRecorder {
		t.Helper()
		timestamp := fmt.Sprintf("%d", time.Now().UTC().Unix())
		canonical := fmt.Sprintf("v1\n%s\n%s\nPOST\n%s\n%s\n%s", timestamp, nonce, agentDSHModelRelayPath, sessionID, modelName)
		request := httptest.NewRequest(http.MethodPost, agentDSHModelRelayPath, strings.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("X-Lain42-Agent-Session", sessionID)
		request.Header.Set("X-Lain42-Agent-Model", modelName)
		request.Header.Set("X-Lain42-Timestamp", timestamp)
		request.Header.Set("X-Lain42-Nonce", nonce)
		request.Header.Set("X-Lain42-Signature", common.GenerateHMACWithKey([]byte(secret), canonical))
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		return response
	}

	first := makeRequest(sessionOne.SessionId, "0123456789abcdef0123456789abcdef")
	assert.Equal(t, http.StatusOK, first.Code)
	assert.Contains(t, first.Body.String(), fmt.Sprintf(`"id":%d`, userOne.Id))
	assert.Contains(t, first.Body.String(), `"group":"default"`)

	replay := makeRequest(sessionOne.SessionId, "0123456789abcdef0123456789abcdef")
	assert.Equal(t, http.StatusUnauthorized, replay.Code)

	second := makeRequest(sessionTwo.SessionId, "fedcba9876543210fedcba9876543210")
	assert.Equal(t, http.StatusOK, second.Code)
	assert.Contains(t, second.Body.String(), fmt.Sprintf(`"id":%d`, userTwo.Id))
}

func TestAgentDSHModelAuthAcceptsBoundedImageRequestAboveLegacyLimit(t *testing.T) {
	setupAgentDSHMiddlewareTest(t)
	gin.SetMode(gin.TestMode)
	secret := "0123456789abcdef0123456789abcdef"
	t.Setenv("LAIN42_AGENT_MODEL_RELAY_SECRET", secret)
	user := createAgentDSHTestUser(t, "agent-dsh-image-model-owner")
	session, err := model.CreateAgentDSHSession(user.Id, time.Now().UTC())
	require.NoError(t, err)
	modelName := "openai/gpt-5.6-sol"
	encoded := strings.Repeat("A", 5*1024*1024)
	body := `{"model":"openai/gpt-5.6-sol","messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"data:image/png;base64,` + encoded + `"}}]}]}`
	router := gin.New()
	router.POST(agentDSHModelRelayPath, AgentDSHModelAuth(), func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"id": c.GetInt("id")})
	})
	timestamp := fmt.Sprintf("%d", time.Now().UTC().Unix())
	nonce := "0123456789abcdef0123456789abcdef"
	canonical := fmt.Sprintf("v1\n%s\n%s\nPOST\n%s\n%s\n%s", timestamp, nonce, agentDSHModelRelayPath, session.SessionId, modelName)
	request := httptest.NewRequest(http.MethodPost, agentDSHModelRelayPath, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Lain42-Agent-Session", session.SessionId)
	request.Header.Set("X-Lain42-Agent-Model", modelName)
	request.Header.Set("X-Lain42-Timestamp", timestamp)
	request.Header.Set("X-Lain42-Nonce", nonce)
	request.Header.Set("X-Lain42-Signature", common.GenerateHMACWithKey([]byte(secret), canonical))
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)

	assert.Equal(t, http.StatusOK, response.Code)
	assert.Contains(t, response.Body.String(), fmt.Sprintf(`"id":%d`, user.Id))
}

func TestAgentDSHToolAuthBindsSignedToolCallsToTheSessionOwner(t *testing.T) {
	setupAgentDSHMiddlewareTest(t)
	gin.SetMode(gin.TestMode)
	secret := "0123456789abcdef0123456789abcdef"
	t.Setenv("LAIN42_DSH_BRIDGE_SECRET", secret)
	user := createAgentDSHTestUser(t, "agent-dsh-tool-owner")
	session, err := model.CreateAgentDSHSession(user.Id, time.Now().UTC())
	require.NoError(t, err)
	body := fmt.Sprintf(`{"version":1,"session_id":%q,"tool":"web_search","arguments":{"query":"rust"}}`, session.SessionId)
	router := gin.New()
	router.POST(agentDSHToolRelayPath, AgentDSHToolAuth(), func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"id": c.GetInt("id")})
	})
	request := httptest.NewRequest(http.MethodPost, agentDSHToolRelayPath, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	timestamp := fmt.Sprintf("%d", time.Now().UTC().Unix())
	nonce := "fedcba9876543210fedcba9876543210"
	digest := sha256.Sum256([]byte(body))
	canonical := fmt.Sprintf("v1\n%s\n%s\nPOST\n%s\n%s", timestamp, nonce, agentDSHToolRelayPath, hex.EncodeToString(digest[:]))
	request.Header.Set("X-Lain42-Timestamp", timestamp)
	request.Header.Set("X-Lain42-Nonce", nonce)
	request.Header.Set("X-Lain42-Signature", common.GenerateHMACWithKey([]byte(secret), canonical))
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	assert.Equal(t, http.StatusOK, response.Code)
	assert.Contains(t, response.Body.String(), fmt.Sprintf(`"id":%d`, user.Id))
}

func TestAgentDSHRelaysRejectOversizedBodiesBeforeBuffering(t *testing.T) {
	gin.SetMode(gin.TestMode)
	t.Setenv("LAIN42_AGENT_MODEL_RELAY_SECRET", "0123456789abcdef0123456789abcdef")
	modelRouter := gin.New()
	modelRouter.POST(agentDSHModelRelayPath, AgentDSHModelAuth())
	modelBody := `{"model":"x"}` + strings.Repeat(" ", agentDSHModelBodyLimit)
	modelRequest := httptest.NewRequest(http.MethodPost, agentDSHModelRelayPath, strings.NewReader(modelBody))
	modelRequest.Header.Set("Content-Type", "application/json")
	modelResponse := httptest.NewRecorder()
	modelRouter.ServeHTTP(modelResponse, modelRequest)
	assert.Equal(t, http.StatusRequestEntityTooLarge, modelResponse.Code)

	t.Setenv("LAIN42_DSH_BRIDGE_SECRET", "0123456789abcdef0123456789abcdef")
	toolRouter := gin.New()
	toolRouter.POST(agentDSHToolRelayPath, AgentDSHToolAuth())
	toolBody := `{"version":1}` + strings.Repeat(" ", agentDSHToolBodyLimit)
	toolRequest := httptest.NewRequest(http.MethodPost, agentDSHToolRelayPath, strings.NewReader(toolBody))
	toolRequest.Header.Set("Content-Type", "application/json")
	toolResponse := httptest.NewRecorder()
	toolRouter.ServeHTTP(toolResponse, toolRequest)
	assert.Equal(t, http.StatusRequestEntityTooLarge, toolResponse.Code)
}
