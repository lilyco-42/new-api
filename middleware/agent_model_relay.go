package middleware

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
)

const (
	AgentModelRelayPath            = "/v1/agent/chat/completions"
	AgentModelRelaySecretEnv       = "LAIN42_AGENT_MODEL_RELAY_SECRET"
	agentModelRelayMaxBodyBytes    = 20 << 20
	agentModelRelaySignatureWindow = 60 * time.Second
)

var (
	agentModelRelaySessionPattern = regexp.MustCompile(`^[A-Za-z0-9]{64}$`)
	agentModelRelayNoncePattern   = regexp.MustCompile(`^[0-9a-f]{32}$`)
	agentModelRelayModelPattern   = regexp.MustCompile(`^[A-Za-z0-9._:/-]{1,128}$`)
	agentModelRelaySignature      = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

// AgentModelRelayAuth authenticates DSH's server-to-server model calls and
// derives billing ownership only from the active database session mapping.
// The caller cannot provide a user ID or a billing group.
func AgentModelRelayAuth() gin.HandlerFunc {
	return func(c *gin.Context) {
		secret := os.Getenv(AgentModelRelaySecretEnv)
		if len([]byte(secret)) < 32 {
			agentModelRelayError(c, http.StatusServiceUnavailable, "AGENT_MODEL_RELAY_DISABLED", "agent model relay is not configured")
			return
		}
		if c.Request.Method != http.MethodPost || c.Request.URL.Path != AgentModelRelayPath || c.Request.URL.RawQuery != "" {
			agentModelRelayError(c, http.StatusNotFound, "AGENT_MODEL_RELAY_NOT_FOUND", "agent model relay route not found")
			return
		}
		if mediaType := strings.ToLower(strings.TrimSpace(strings.Split(c.GetHeader("Content-Type"), ";")[0])); mediaType != "application/json" {
			agentModelRelayError(c, http.StatusUnsupportedMediaType, "AGENT_MODEL_RELAY_CONTENT_TYPE", "application/json is required")
			return
		}
		if c.Request.ContentLength > agentModelRelayMaxBodyBytes {
			agentModelRelayError(c, http.StatusRequestEntityTooLarge, "AGENT_MODEL_RELAY_BODY_TOO_LARGE", "request body is too large")
			return
		}
		body, err := io.ReadAll(io.LimitReader(c.Request.Body, agentModelRelayMaxBodyBytes+1))
		if err != nil || len(body) == 0 || len(body) > agentModelRelayMaxBodyBytes {
			agentModelRelayError(c, http.StatusBadRequest, "AGENT_MODEL_RELAY_INVALID_BODY", "invalid or oversized request body")
			return
		}
		c.Request.Body = io.NopCloser(bytes.NewReader(body))

		sessionID, modelName, timestamp, nonce, signature, ok := agentModelRelayHeaders(c.Request.Header)
		if !ok {
			agentModelRelayError(c, http.StatusUnauthorized, "AGENT_MODEL_RELAY_UNAUTHORIZED", "invalid agent model relay credentials")
			return
		}
		requestModel := struct {
			Model string `json:"model"`
		}{}
		if err := json.Unmarshal(body, &requestModel); err != nil || requestModel.Model != modelName {
			agentModelRelayError(c, http.StatusUnauthorized, "AGENT_MODEL_RELAY_UNAUTHORIZED", "invalid agent model relay credentials")
			return
		}
		now := time.Now().UTC()
		requestTime, err := strconv.ParseInt(timestamp, 10, 64)
		if err != nil || absDuration(now.Sub(time.Unix(requestTime, 0))) > agentModelRelaySignatureWindow {
			agentModelRelayError(c, http.StatusUnauthorized, "AGENT_MODEL_RELAY_UNAUTHORIZED", "invalid agent model relay credentials")
			return
		}
		expected := signAgentModelRelayRequest(secret, timestamp, nonce, sessionID, modelName)
		expectedBytes, _ := hex.DecodeString(expected)
		signatureBytes, _ := hex.DecodeString(signature)
		if !hmac.Equal(expectedBytes, signatureBytes) {
			agentModelRelayError(c, http.StatusUnauthorized, "AGENT_MODEL_RELAY_UNAUTHORIZED", "invalid agent model relay credentials")
			return
		}

		session, err := model.ResolveAgentWebSessionForRelay(sessionID)
		if err != nil {
			agentModelRelayError(c, http.StatusUnauthorized, "AGENT_MODEL_RELAY_UNAUTHORIZED", "invalid agent model relay credentials")
			return
		}
		user, err := model.GetUserCache(session.UserId)
		if err != nil {
			agentModelRelayError(c, http.StatusServiceUnavailable, "AGENT_MODEL_RELAY_USER_LOOKUP_FAILED", "unable to authorize the agent model request")
			return
		}
		if user.Status != common.UserStatusEnabled {
			agentModelRelayError(c, http.StatusForbidden, "AGENT_MODEL_RELAY_USER_DISABLED", "the account is disabled")
			return
		}
		expiresAt := now.Add(agentModelRelaySignatureWindow)
		if signedExpiry := time.Unix(requestTime, 0).Add(agentModelRelaySignatureWindow); signedExpiry.After(expiresAt) {
			expiresAt = signedExpiry
		}
		if err := model.ClaimAgentModelRelayNonce(nonce, expiresAt, now); err != nil {
			if err == model.ErrAgentModelRelayReplay {
				agentModelRelayError(c, http.StatusUnauthorized, "AGENT_MODEL_RELAY_UNAUTHORIZED", "invalid agent model relay credentials")
				return
			}
			agentModelRelayError(c, http.StatusServiceUnavailable, "AGENT_MODEL_RELAY_REPLAY_STORE_FAILED", "unable to authorize the agent model request")
			return
		}

		user.WriteContext(c)
		c.Set("id", session.UserId)
		c.Set("username", user.Username)
		c.Set("role", user.Role)
		c.Set("use_access_token", false)
		common.SetContextKey(c, constant.ContextKeyUsingGroup, user.Group)
		// Reuse the existing Playground relay and quota ledger without exposing
		// its cookie-authenticated route to the DSH service.
		c.Request.URL.Path = "/pg/chat/completions"
		c.Next()
	}
}

func agentModelRelayHeaders(header http.Header) (sessionID, modelName, timestamp, nonce, signature string, ok bool) {
	readSingle := func(name string) (string, bool) {
		values := header.Values(name)
		return func() (string, bool) {
			if len(values) != 1 {
				return "", false
			}
			return strings.TrimSpace(values[0]), true
		}()
	}
	var valid bool
	if sessionID, valid = readSingle("X-Lain42-Agent-Session"); !valid || !agentModelRelaySessionPattern.MatchString(sessionID) {
		return "", "", "", "", "", false
	}
	if modelName, valid = readSingle("X-Lain42-Agent-Model"); !valid || !agentModelRelayModelPattern.MatchString(modelName) {
		return "", "", "", "", "", false
	}
	if timestamp, valid = readSingle("X-Lain42-Timestamp"); !valid || len(timestamp) != 10 {
		return "", "", "", "", "", false
	}
	if nonce, valid = readSingle("X-Lain42-Nonce"); !valid || !agentModelRelayNoncePattern.MatchString(nonce) {
		return "", "", "", "", "", false
	}
	if signature, valid = readSingle("X-Lain42-Signature"); !valid || !agentModelRelaySignature.MatchString(signature) {
		return "", "", "", "", "", false
	}
	return sessionID, modelName, timestamp, nonce, signature, true
}

// SignAgentModelRelayRequest is shared by the DSH sender and conformance tests.
func SignAgentModelRelayRequest(secret, timestamp, nonce, sessionID, modelName string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte("v1\n" + timestamp + "\n" + nonce + "\nPOST\n" + AgentModelRelayPath + "\n" + sessionID + "\n" + modelName))
	return hex.EncodeToString(mac.Sum(nil))
}

func signAgentModelRelayRequest(secret, timestamp, nonce, sessionID, modelName string) string {
	return SignAgentModelRelayRequest(secret, timestamp, nonce, sessionID, modelName)
}

func absDuration(value time.Duration) time.Duration {
	if value < 0 {
		return -value
	}
	return value
}

func agentModelRelayError(c *gin.Context, status int, code, message string) {
	c.AbortWithStatusJSON(status, gin.H{"error": gin.H{"code": code, "message": message, "type": "authentication_error"}})
}
