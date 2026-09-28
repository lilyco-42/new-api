package service

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"strconv"
	"time"

	"github.com/QuantumNous/new-api/model"
)

const (
	AgentDSHToolRelayPath       = "/api/agent/bridge/v1/tool"
	AgentDSHToolRelayMaxBody    = 32 << 10
	agentDSHToolRelayTimeWindow = 60 * time.Second
)

var (
	ErrAgentToolRelayDisabled = errors.New("agent tool relay is not configured")
	ErrAgentToolRelayAuth     = errors.New("agent tool relay authentication failed")
	ErrAgentToolRelayReplay   = errors.New("agent tool relay request replayed")
)

// AuthenticateAgentToolRelayRequest validates and consumes the single-use
// HMAC request sent by the private DSH service. Identity is resolved from the
// signed internal DSH session after this check; callers never supply an owner.
func AuthenticateAgentToolRelayRequest(body []byte, timestamp, nonce, signature string) error {
	secret := []byte(os.Getenv(AgentDSHBridgeSecretEnv))
	if len(secret) < 32 {
		return ErrAgentToolRelayDisabled
	}
	if len(body) == 0 || len(body) > AgentDSHToolRelayMaxBody || len(timestamp) != 10 || len(nonce) != 32 || len(signature) != 64 {
		return ErrAgentToolRelayAuth
	}
	for _, character := range nonce {
		if !(character >= '0' && character <= '9' || character >= 'a' && character <= 'f') {
			return ErrAgentToolRelayAuth
		}
	}
	for _, character := range signature {
		if !(character >= '0' && character <= '9' || character >= 'a' && character <= 'f') {
			return ErrAgentToolRelayAuth
		}
	}
	parsedTimestamp, err := strconv.ParseInt(timestamp, 10, 64)
	if err != nil {
		return ErrAgentToolRelayAuth
	}
	now := time.Now().UTC()
	signedAt := time.Unix(parsedTimestamp, 0)
	if signedAt.Before(now.Add(-agentDSHToolRelayTimeWindow)) || signedAt.After(now.Add(agentDSHToolRelayTimeWindow)) {
		return ErrAgentToolRelayAuth
	}
	bodyDigest := sha256.Sum256(body)
	canonical := fmt.Sprintf("v1\n%s\n%s\nPOST\n%s\n%s", timestamp, nonce, AgentDSHToolRelayPath, hex.EncodeToString(bodyDigest[:]))
	mac := hmac.New(sha256.New, secret)
	_, _ = mac.Write([]byte(canonical))
	expected, err := hex.DecodeString(signature)
	if err != nil || !hmac.Equal(expected, mac.Sum(nil)) {
		return ErrAgentToolRelayAuth
	}
	if err := model.ClaimAgentModelRelayNonce(nonce, now.Add(agentDSHToolRelayTimeWindow), now); err != nil {
		if errors.Is(err, model.ErrAgentModelRelayReplay) {
			return ErrAgentToolRelayReplay
		}
		return ErrAgentToolRelayAuth
	}
	return nil
}
