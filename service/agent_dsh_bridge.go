package service

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/google/uuid"
)

const (
	AgentDSHBridgeURLEnv       = "LAIN42_DSH_BRIDGE_URL"
	AgentDSHBridgeSecretEnv    = "LAIN42_DSH_BRIDGE_SECRET"
	AgentDSHBridgePath         = "/lain42/bridge/v1/turn"
	AgentWebTurnMaxTextBytes   = 24 << 10
	AgentWebTurnMaxBodyBytes   = AgentWebTurnMaxTextBytes + 512
	agentDSHBridgeTimeout      = 125 * time.Second
	agentDSHBridgeMaxReplySize = 256 << 10
)

var (
	ErrAgentTurnInvalidRequest = errors.New("invalid agent turn request")
	ErrAgentTurnBridgeDisabled = errors.New("agent turn bridge is not configured")
	ErrAgentTurnBridgeTimeout  = errors.New("agent turn bridge timed out")
	ErrAgentTurnBridgeFailed   = errors.New("agent turn bridge failed")
	agentDSHBridgeHTTPClient   = &http.Client{
		Timeout: agentDSHBridgeTimeout,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
)

type AgentTurnResult struct {
	RequestID string `json:"request_id"`
	Answer    string `json:"answer"`
}

type agentDSHTurnRequest struct {
	Version   int    `json:"version"`
	SessionID string `json:"sessionId"`
	RequestID string `json:"requestId"`
	Model     string `json:"model,omitempty"`
	Text      string `json:"text"`
}

func validAgentDSHModel(model string) bool {
	if len(model) == 0 || len(model) > 128 {
		return false
	}
	for _, character := range model {
		if !(character >= 'a' && character <= 'z' || character >= 'A' && character <= 'Z' || character >= '0' && character <= '9' || character == '.' || character == '_' || character == ':' || character == '/' || character == '-') {
			return false
		}
	}
	return true
}

type agentDSHTurnResponse struct {
	Version   int    `json:"version"`
	RequestID string `json:"requestId"`
	Answer    string `json:"answer"`
	Error     string `json:"error"`
}

// SubmitAgentWebTurn forwards one authenticated browser turn to the private
// DSH bridge. Ownership comes from the active server-side session mapping;
// browser input can never select the internal DSH session or account.
func SubmitAgentWebTurn(parent context.Context, userID int, publicSessionID, text, clientRequestID, modelName string) (*AgentTurnResult, error) {
	publicSessionID = strings.TrimSpace(publicSessionID)
	if userID <= 0 || len(publicSessionID) != 64 || len(strings.TrimSpace(text)) == 0 || len([]byte(text)) > AgentWebTurnMaxTextBytes {
		return nil, ErrAgentTurnInvalidRequest
	}
	clientRequestID = strings.TrimSpace(clientRequestID)
	if len(clientRequestID) > 128 {
		return nil, ErrAgentTurnInvalidRequest
	}
	for _, character := range clientRequestID {
		if !(character >= 'a' && character <= 'z' || character >= 'A' && character <= 'Z' || character >= '0' && character <= '9' || character == '-' || character == '_') {
			return nil, ErrAgentTurnInvalidRequest
		}
	}
	modelName = strings.TrimSpace(modelName)
	if modelName != "" && !validAgentDSHModel(modelName) {
		return nil, ErrAgentTurnInvalidRequest
	}
	session, err := model.ResolveAgentWebSession(userID, publicSessionID)
	if err != nil {
		return nil, err
	}
	endpoint, secret, err := agentDSHBridgeConfig(os.Getenv(AgentDSHBridgeURLEnv), os.Getenv(AgentDSHBridgeSecretEnv))
	if err != nil {
		return nil, err
	}
	requestID := uuid.NewString()
	if clientRequestID != "" {
		// Stable IDs let a browser retry an ambiguous network failure without
		// prompting DSH twice. Scope the client's opaque message key to the
		// authenticated account and private DSH session before deriving the ID.
		requestID = uuid.NewSHA1(uuid.NameSpaceURL, []byte(fmt.Sprintf("lain42-agent-turn:%d:%s:%s", userID, session.DshSessionId, clientRequestID))).String()
	}
	turn := agentDSHTurnRequest{Version: 1, SessionID: session.DshSessionId, RequestID: requestID, Model: modelName, Text: text}
	body, err := common.Marshal(turn)
	if err != nil {
		return nil, ErrAgentTurnBridgeFailed
	}
	ctx, cancel := context.WithTimeout(parent, agentDSHBridgeTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), bytes.NewReader(body))
	if err != nil {
		return nil, ErrAgentTurnBridgeDisabled
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	if err := setAgentDSHBridgeHeaders(request, secret, body, time.Now().UTC()); err != nil {
		return nil, ErrAgentTurnBridgeFailed
	}
	response, err := agentDSHBridgeHTTPClient.Do(request)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return nil, ErrAgentTurnBridgeTimeout
		}
		return nil, ErrAgentTurnBridgeFailed
	}
	defer response.Body.Close()
	responseBody, err := io.ReadAll(io.LimitReader(response.Body, agentDSHBridgeMaxReplySize+1))
	if err != nil || len(responseBody) == 0 || len(responseBody) > agentDSHBridgeMaxReplySize {
		return nil, ErrAgentTurnBridgeFailed
	}
	var result agentDSHTurnResponse
	if err := common.Unmarshal(responseBody, &result); err != nil {
		return nil, ErrAgentTurnBridgeFailed
	}
	if response.StatusCode == http.StatusGatewayTimeout || result.Error == "agent_turn_timeout" {
		return nil, ErrAgentTurnBridgeTimeout
	}
	if response.StatusCode != http.StatusOK || result.Version != 1 || result.RequestID != requestID || strings.TrimSpace(result.Answer) == "" {
		return nil, ErrAgentTurnBridgeFailed
	}
	return &AgentTurnResult{RequestID: requestID, Answer: result.Answer}, nil
}

func agentDSHBridgeConfig(rawURL, secret string) (*url.URL, []byte, error) {
	secretBytes := []byte(secret)
	if len(secretBytes) < 32 {
		return nil, nil, ErrAgentTurnBridgeDisabled
	}
	endpoint, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || endpoint == nil || endpoint.Host == "" || endpoint.User != nil || endpoint.RawQuery != "" || endpoint.Fragment != "" || endpoint.Path != AgentDSHBridgePath {
		return nil, nil, ErrAgentTurnBridgeDisabled
	}
	if endpoint.Scheme != "https" && !(endpoint.Scheme == "http" && isLoopbackHost(endpoint.Hostname())) {
		return nil, nil, ErrAgentTurnBridgeDisabled
	}
	return endpoint, secretBytes, nil
}

func isLoopbackHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func setAgentDSHBridgeHeaders(request *http.Request, secret, body []byte, now time.Time) error {
	timestamp := fmt.Sprintf("%d", now.Unix())
	nonceBytes := make([]byte, 16)
	if _, err := rand.Read(nonceBytes); err != nil {
		return err
	}
	nonce := hex.EncodeToString(nonceBytes)
	bodyDigest := sha256.Sum256(body)
	canonical := fmt.Sprintf("v1\n%s\n%s\nPOST\n%s\n%s", timestamp, nonce, AgentDSHBridgePath, hex.EncodeToString(bodyDigest[:]))
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(canonical))
	request.Header.Set("X-Lain42-Timestamp", timestamp)
	request.Header.Set("X-Lain42-Nonce", nonce)
	request.Header.Set("X-Lain42-Signature", hex.EncodeToString(mac.Sum(nil)))
	return nil
}
