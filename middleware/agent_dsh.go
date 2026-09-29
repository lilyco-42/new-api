package middleware

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/dto"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
)

const (
	agentDSHModelRelayPath = "/v1/agent/chat/completions"
	agentDSHToolRelayPath  = "/api/agent/bridge/v1/tool"
	agentDSHAuthWindow     = 60 * time.Second
	agentDSHNonceRetention = 2 * time.Minute
	agentDSHToolBodyLimit  = 32 * 1024
	// DSH image requests use bounded base64 content; 12 MiB covers the
	// 8 MiB decoded turn-image budget plus JSON encoding overhead.
	agentDSHModelBodyLimit = 12 * 1024 * 1024
)

var (
	agentDSHSessionIDPattern = regexp.MustCompile(`^[A-Za-z0-9]{64}$`)
	agentDSHModelPattern     = regexp.MustCompile(`^[A-Za-z0-9._:/-]{1,128}$`)
	agentDSHNoncePattern     = regexp.MustCompile(`^[0-9a-f]{32}$`)
	agentDSHSignaturePattern = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

// AgentDSHModelAuth authenticates DSH's server-side model call and projects
// the owning New API account into the existing distribution/playground path.
// The browser cannot construct this request because the HMAC secret stays on
// the two servers.
func AgentDSHModelAuth() func(c *gin.Context) {
	return func(c *gin.Context) {
		secret := os.Getenv("LAIN42_AGENT_MODEL_RELAY_SECRET")
		if len(secret) < 32 {
			writeAgentDSHAuthError(c, http.StatusServiceUnavailable, "agent_model_relay_unavailable")
			return
		}
		if c.Request.Method != http.MethodPost || c.Request.URL.Path != agentDSHModelRelayPath || !isAgentDSHJSON(c) {
			writeAgentDSHAuthError(c, http.StatusUnauthorized, "agent_relay_unauthorized")
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, agentDSHModelBodyLimit)
		storage, err := common.GetBodyStorage(c)
		if err != nil {
			if isAgentDSHBodyLimitError(err) {
				writeAgentDSHAuthError(c, http.StatusRequestEntityTooLarge, "agent_relay_invalid_request")
				return
			}
			writeAgentDSHAuthError(c, http.StatusBadRequest, "agent_relay_invalid_request")
			return
		}
		if storage.Size() <= 0 || storage.Size() > agentDSHModelBodyLimit {
			writeAgentDSHAuthError(c, http.StatusRequestEntityTooLarge, "agent_relay_invalid_request")
			return
		}
		body, err := storage.Bytes()
		if err != nil || len(body) == 0 {
			writeAgentDSHAuthError(c, http.StatusRequestEntityTooLarge, "agent_relay_invalid_request")
			return
		}
		sessionID, modelName, timestamp, nonce, signature, ok := agentDSHHeaders(c)
		if !ok || !agentDSHSessionIDPattern.MatchString(sessionID) || !agentDSHModelPattern.MatchString(modelName) {
			writeAgentDSHAuthError(c, http.StatusUnauthorized, "agent_relay_unauthorized")
			return
		}
		now := time.Now().UTC()
		if !verifyAgentDSHModelSignature(secret, timestamp, nonce, signature, sessionID, modelName, now) {
			writeAgentDSHAuthError(c, http.StatusUnauthorized, "agent_relay_unauthorized")
			return
		}
		requestModel, _, err := getModelRequest(c)
		if err != nil || requestModel.Model != modelName {
			writeAgentDSHAuthError(c, http.StatusBadRequest, "agent_relay_model_mismatch")
			return
		}
		userID, err := model.GetAgentDSHSessionOwner(sessionID)
		if errors.Is(err, model.ErrAgentDSHSessionNotFound) {
			writeAgentDSHAuthError(c, http.StatusUnauthorized, "agent_relay_unauthorized")
			return
		}
		if err != nil {
			writeAgentDSHAuthError(c, http.StatusInternalServerError, "agent_relay_unavailable")
			return
		}
		if err := claimAgentDSHNonce("lain42_dsh_model_v1", nonce, now); err != nil {
			if !errors.Is(err, model.ErrAuthFlowConsumed) {
				writeAgentDSHAuthError(c, http.StatusInternalServerError, "agent_relay_unavailable")
				return
			}
			writeAgentDSHAuthError(c, http.StatusUnauthorized, "agent_relay_unauthorized")
			return
		}
		if !setAgentDSHRelayUserContext(c, userID) {
			writeAgentDSHAuthError(c, http.StatusUnauthorized, "agent_relay_unauthorized")
			return
		}
		c.Next()
	}
}

// AgentDSHToolAuth authenticates a DSH read-tool request, resolves the New
// API account from its owned session, and runs before per-user rate limiting.
func AgentDSHToolAuth() func(c *gin.Context) {
	return func(c *gin.Context) {
		secret := os.Getenv("LAIN42_DSH_BRIDGE_SECRET")
		if len(secret) < 32 {
			writeAgentDSHAuthError(c, http.StatusServiceUnavailable, "agent_tool_relay_unavailable")
			return
		}
		if c.Request.Method != http.MethodPost || c.Request.URL.Path != agentDSHToolRelayPath || !isAgentDSHJSON(c) {
			writeAgentDSHAuthError(c, http.StatusUnauthorized, "agent_relay_unauthorized")
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, agentDSHToolBodyLimit)
		storage, err := common.GetBodyStorage(c)
		if err != nil {
			if isAgentDSHBodyLimitError(err) {
				writeAgentDSHAuthError(c, http.StatusRequestEntityTooLarge, "agent_relay_invalid_request")
				return
			}
			writeAgentDSHAuthError(c, http.StatusBadRequest, "agent_relay_invalid_request")
			return
		}
		if storage.Size() <= 0 || storage.Size() > agentDSHToolBodyLimit {
			writeAgentDSHAuthError(c, http.StatusRequestEntityTooLarge, "agent_relay_invalid_request")
			return
		}
		body, err := storage.Bytes()
		if err != nil || len(body) == 0 {
			writeAgentDSHAuthError(c, http.StatusRequestEntityTooLarge, "agent_relay_invalid_request")
			return
		}
		var request dto.AgentDSHToolRelayRequest
		if err := common.Unmarshal(body, &request); err != nil || request.Version != 1 || !agentDSHSessionIDPattern.MatchString(request.SessionID) {
			writeAgentDSHAuthError(c, http.StatusBadRequest, "agent_relay_invalid_request")
			return
		}
		timestamp, okTimestamp := singleAgentDSHHeader(c, "X-Lain42-Timestamp")
		nonce, okNonce := singleAgentDSHHeader(c, "X-Lain42-Nonce")
		signature, okSignature := singleAgentDSHHeader(c, "X-Lain42-Signature")
		if !okTimestamp || !okNonce || !okSignature {
			writeAgentDSHAuthError(c, http.StatusUnauthorized, "agent_relay_unauthorized")
			return
		}
		now := time.Now().UTC()
		if !verifyAgentDSHToolSignature(secret, body, timestamp, nonce, signature, now) {
			writeAgentDSHAuthError(c, http.StatusUnauthorized, "agent_relay_unauthorized")
			return
		}
		userID, err := model.GetAgentDSHSessionOwner(request.SessionID)
		if errors.Is(err, model.ErrAgentDSHSessionNotFound) {
			writeAgentDSHAuthError(c, http.StatusUnauthorized, "agent_relay_unauthorized")
			return
		}
		if err != nil {
			writeAgentDSHAuthError(c, http.StatusInternalServerError, "agent_relay_unavailable")
			return
		}
		if err := claimAgentDSHNonce("lain42_dsh_tool_v1", nonce, now); err != nil {
			if !errors.Is(err, model.ErrAuthFlowConsumed) {
				writeAgentDSHAuthError(c, http.StatusInternalServerError, "agent_relay_unavailable")
				return
			}
			writeAgentDSHAuthError(c, http.StatusUnauthorized, "agent_relay_unauthorized")
			return
		}
		if !setAgentDSHRelayUserContext(c, userID) {
			writeAgentDSHAuthError(c, http.StatusUnauthorized, "agent_relay_unauthorized")
			return
		}
		c.Next()
	}
}

func agentDSHHeaders(c *gin.Context) (sessionID, modelName, timestamp, nonce, signature string, ok bool) {
	var found bool
	if sessionID, found = singleAgentDSHHeader(c, "X-Lain42-Agent-Session"); !found {
		return "", "", "", "", "", false
	}
	if modelName, found = singleAgentDSHHeader(c, "X-Lain42-Agent-Model"); !found {
		return "", "", "", "", "", false
	}
	if timestamp, found = singleAgentDSHHeader(c, "X-Lain42-Timestamp"); !found {
		return "", "", "", "", "", false
	}
	if nonce, found = singleAgentDSHHeader(c, "X-Lain42-Nonce"); !found {
		return "", "", "", "", "", false
	}
	if signature, found = singleAgentDSHHeader(c, "X-Lain42-Signature"); !found {
		return "", "", "", "", "", false
	}
	return sessionID, modelName, timestamp, nonce, signature, true
}

func singleAgentDSHHeader(c *gin.Context, name string) (string, bool) {
	values := c.Request.Header.Values(name)
	if len(values) != 1 || strings.TrimSpace(values[0]) == "" {
		return "", false
	}
	return strings.TrimSpace(values[0]), true
}

func isAgentDSHJSON(c *gin.Context) bool {
	contentType := strings.TrimSpace(strings.Split(c.GetHeader("Content-Type"), ";")[0])
	return strings.EqualFold(contentType, "application/json")
}

func isAgentDSHBodyLimitError(err error) bool {
	var maxBytesError *http.MaxBytesError
	return errors.As(err, &maxBytesError) || common.IsRequestBodyTooLargeError(err)
}

func verifyAgentDSHModelSignature(secret, timestamp, nonce, signature, sessionID, modelName string, now time.Time) bool {
	if !validAgentDSHTimestamp(timestamp, now) || !agentDSHNoncePattern.MatchString(nonce) || !agentDSHSignaturePattern.MatchString(signature) {
		return false
	}
	canonical := fmt.Sprintf("v1\n%s\n%s\nPOST\n%s\n%s\n%s", timestamp, nonce, agentDSHModelRelayPath, sessionID, modelName)
	return verifyAgentDSHMAC(secret, canonical, signature)
}

func verifyAgentDSHToolSignature(secret string, body []byte, timestamp, nonce, signature string, now time.Time) bool {
	if !validAgentDSHTimestamp(timestamp, now) || !agentDSHNoncePattern.MatchString(nonce) || !agentDSHSignaturePattern.MatchString(signature) {
		return false
	}
	digest := sha256.Sum256(body)
	canonical := fmt.Sprintf("v1\n%s\n%s\nPOST\n%s\n%s", timestamp, nonce, agentDSHToolRelayPath, hex.EncodeToString(digest[:]))
	return verifyAgentDSHMAC(secret, canonical, signature)
}

func verifyAgentDSHMAC(secret, canonical, signature string) bool {
	expected, err := hex.DecodeString(common.GenerateHMACWithKey([]byte(secret), canonical))
	if err != nil {
		return false
	}
	provided, err := hex.DecodeString(signature)
	return err == nil && hmac.Equal(expected, provided)
}

func validAgentDSHTimestamp(timestamp string, now time.Time) bool {
	if len(timestamp) != 10 {
		return false
	}
	seconds, err := strconv.ParseInt(timestamp, 10, 64)
	if err != nil {
		return false
	}
	return now.Sub(time.Unix(seconds, 0)).Abs() <= agentDSHAuthWindow
}

func claimAgentDSHNonce(purpose, nonce string, now time.Time) error {
	return model.ClaimExternalAuthAssertion(purpose, nonce, now.Add(agentDSHNonceRetention))
}

func setAgentDSHRelayUserContext(c *gin.Context, userID int) bool {
	user, err := model.GetUserCache(userID)
	if err != nil || user == nil || user.Status != common.UserStatusEnabled {
		return false
	}
	setDashboardAuthContext(c, user, service.AuthIdentity{
		UserID:          user.Id,
		UserAuthVersion: user.AuthVersion,
	}, false)
	common.SetContextKey(c, constant.ContextKeyUsingGroup, user.Group)
	return true
}

func writeAgentDSHAuthError(c *gin.Context, status int, code string) {
	c.Header("Cache-Control", "no-store")
	c.AbortWithStatusJSON(status, gin.H{"error": gin.H{"code": code}})
}
