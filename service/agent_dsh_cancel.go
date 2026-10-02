package service

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
)

const AgentDSHCancelPath = "/lain42/bridge/v1/cancel"

// AgentDSHCancellationReceipt is an execution-scoped runtime receipt. A request
// for cancellation or a missing target is not evidence of terminal settlement.
type AgentDSHCancellationReceipt struct {
	Version   int    `json:"version"`
	SessionID string `json:"sessionId"`
	RequestID string `json:"requestId"`
	Accepted  bool   `json:"accepted"`
	Status    string `json:"status"`
	Turn      *int   `json:"turn,omitempty"`
}

// AgentDSHEndpoint permits a private origin configured by the operator, with
// HTTPS required except for same-host loopback deployments.
func AgentDSHEndpoint(path string) (string, error) {
	raw := strings.TrimSpace(os.Getenv("LAIN42_DSH_BASE_URL"))
	parsed, err := url.Parse(raw)
	if err != nil || raw == "" || parsed == nil || parsed.User != nil || parsed.Host == "" || parsed.RawQuery != "" || parsed.Fragment != "" || (parsed.Path != "" && parsed.Path != "/") {
		return "", errors.New("invalid DSH base URL")
	}
	loopback := strings.EqualFold(parsed.Hostname(), "localhost") || parsed.Hostname() == "127.0.0.1" || parsed.Hostname() == "::1"
	if parsed.Scheme != "https" && !(parsed.Scheme == "http" && loopback) {
		return "", errors.New("DSH must use HTTPS except on loopback")
	}
	return strings.TrimRight(parsed.String(), "/") + path, nil
}

// SignAgentDSHRequest binds the operation path as well as the exact body bytes.
// A turn signature cannot authorize a cancellation, even with the same nonce.
func SignAgentDSHRequest(secret, timestamp, nonce, path string, body []byte) string {
	digest := sha256.Sum256(body)
	canonical := fmt.Sprintf("v1\n%s\n%s\nPOST\n%s\n%s", timestamp, nonce, path, hex.EncodeToString(digest[:]))
	return common.GenerateHMACWithKey([]byte(secret), canonical)
}

// RequestAgentDSHCancellation sends only an already authorized request identity.
// The caller must persist intent first; delivery loss must not erase that intent.
func RequestAgentDSHCancellation(ctx context.Context, sessionID, requestID string) (*AgentDSHCancellationReceipt, error) {
	endpoint, err := AgentDSHEndpoint(AgentDSHCancelPath)
	secret := os.Getenv("LAIN42_DSH_BRIDGE_SECRET")
	if err != nil || len(secret) < 32 {
		return nil, errors.New("DSH cancellation transport is not configured")
	}
	body, err := common.Marshal(struct {
		Version   int    `json:"version"`
		SessionID string `json:"sessionId"`
		RequestID string `json:"requestId"`
	}{Version: 1, SessionID: sessionID, RequestID: requestID})
	if err != nil {
		return nil, err
	}
	nonceBytes := make([]byte, 16)
	if _, err = rand.Read(nonceBytes); err != nil {
		return nil, err
	}
	timestamp := strconv.FormatInt(time.Now().UTC().Unix(), 10)
	nonce := hex.EncodeToString(nonceBytes)
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(string(body)))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	request.Header.Set("X-Lain42-Timestamp", timestamp)
	request.Header.Set("X-Lain42-Nonce", nonce)
	request.Header.Set("X-Lain42-Signature", SignAgentDSHRequest(secret, timestamp, nonce, AgentDSHCancelPath, body))
	client := &http.Client{Timeout: 5 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	const receiptLimit = 4096
	bytes, err := io.ReadAll(io.LimitReader(response.Body, receiptLimit+1))
	if err != nil || len(bytes) > receiptLimit || response.StatusCode != http.StatusOK {
		return nil, errors.New("DSH cancellation receipt is unavailable")
	}
	var receipt AgentDSHCancellationReceipt
	if common.Unmarshal(bytes, &receipt) != nil || receipt.Version != 1 || !receipt.Accepted || receipt.SessionID != sessionID || receipt.RequestID != requestID {
		return nil, errors.New("invalid DSH cancellation receipt")
	}
	switch receipt.Status {
	case "cancellation-requested":
		if receipt.Turn == nil || *receipt.Turn < 0 {
			return nil, errors.New("invalid DSH cancellation turn")
		}
	case "removed", "not-active", "not-found", "unsupported":
		if receipt.Turn != nil {
			return nil, errors.New("unexpected DSH cancellation turn")
		}
	default:
		return nil, errors.New("unknown DSH cancellation status")
	}
	return &receipt, nil
}
