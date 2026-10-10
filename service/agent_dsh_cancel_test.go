package service

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestAgentDSHCancellationBindsOperationAndOriginalIdentity(t *testing.T) {
	const secret = "test-only-cancellation-secret-with-32-bytes"
	const requestID = "123e4567-e89b-42d3-a456-426614174000"
	sessionID := strings.Repeat("a", 64)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, http.MethodPost, r.Method)
		assert.Equal(t, AgentDSHCancelPath, r.URL.Path)
		body, err := io.ReadAll(r.Body)
		require.NoError(t, err)
		var request map[string]interface{}
		require.NoError(t, common.Unmarshal(body, &request))
		assert.Equal(t, map[string]interface{}{"version": float64(1), "sessionId": sessionID, "requestId": requestID}, request)
		timestamp, nonce := r.Header.Get("X-Lain42-Timestamp"), r.Header.Get("X-Lain42-Nonce")
		assert.Equal(t, SignAgentDSHRequest(secret, timestamp, nonce, AgentDSHCancelPath, body), r.Header.Get("X-Lain42-Signature"))
		assert.NotEqual(t, SignAgentDSHRequest(secret, timestamp, nonce, "/lain42/bridge/v1/turn", body), r.Header.Get("X-Lain42-Signature"))
		_, _ = io.WriteString(w, `{"version":1,"sessionId":"`+sessionID+`","requestId":"`+requestID+`","accepted":true,"status":"cancellation-requested","turn":7}`)
	}))
	defer server.Close()
	t.Setenv("LAIN42_DSH_BASE_URL", server.URL)
	t.Setenv("LAIN42_DSH_BRIDGE_SECRET", secret)
	receipt, err := RequestAgentDSHCancellation(context.Background(), sessionID, requestID)
	require.NoError(t, err)
	assert.Equal(t, "cancellation-requested", receipt.Status)
	require.NotNil(t, receipt.Turn)
	assert.Equal(t, 7, *receipt.Turn)
}

func TestAgentDSHCancellationRejectsUnboundMalformedAndRedirectedReceipts(t *testing.T) {
	const requestID = "123e4567-e89b-42d3-a456-426614174000"
	sessionID := strings.Repeat("a", 64)
	valid := `{"version":1,"sessionId":"` + sessionID + `","requestId":"` + requestID + `","accepted":true,"status":"removed"}`
	for _, test := range []struct {
		name, body string
		status     int
	}{
		{"other session", strings.Replace(valid, sessionID, strings.Repeat("b", 64), 1), http.StatusOK},
		{"other request", strings.Replace(valid, requestID, "123e4567-e89b-42d3-a456-426614174001", 1), http.StatusOK},
		{"unaccepted", strings.Replace(valid, `"accepted":true`, `"accepted":false`, 1), http.StatusOK},
		{"unknown status", strings.Replace(valid, "removed", "completed", 1), http.StatusOK},
		{"unscoped executing cancellation", strings.Replace(valid, "removed", "cancellation-requested", 1), http.StatusOK},
		{"unexpected turn", strings.TrimSuffix(valid, "}") + `,"turn":7}`, http.StatusOK},
		{"oversized", strings.Repeat("x", 4097), http.StatusOK},
		{"invalid body", `not-json`, http.StatusOK},
		{"private upstream error", `private-detail-must-not-leak`, http.StatusBadGateway},
		{"redirect", valid, http.StatusTemporaryRedirect},
	} {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/redirected" {
					t.Error("cancellation must not follow redirects")
				}
				w.Header().Set("Location", "/redirected")
				w.WriteHeader(test.status)
				_, _ = io.WriteString(w, test.body)
			}))
			defer server.Close()
			t.Setenv("LAIN42_DSH_BASE_URL", server.URL)
			t.Setenv("LAIN42_DSH_BRIDGE_SECRET", "test-only-cancellation-secret-with-32-bytes")
			receipt, err := RequestAgentDSHCancellation(context.Background(), sessionID, requestID)
			require.Error(t, err)
			assert.Nil(t, receipt)
			assert.NotContains(t, err.Error(), "private-detail-must-not-leak")
		})
	}
}

func TestAgentDSHCancellationKeepsInactiveUnknownAndUnsupportedOutcomesDistinct(t *testing.T) {
	const requestID = "123e4567-e89b-42d3-a456-426614174000"
	sessionID := strings.Repeat("a", 64)
	for _, status := range []string{"not-active", "not-found", "unsupported"} {
		t.Run(status, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				_, _ = io.WriteString(w, `{"version":1,"sessionId":"`+sessionID+`","requestId":"`+requestID+`","accepted":true,"status":"`+status+`"}`)
			}))
			defer server.Close()
			t.Setenv("LAIN42_DSH_BASE_URL", server.URL)
			t.Setenv("LAIN42_DSH_BRIDGE_SECRET", "test-only-cancellation-secret-with-32-bytes")
			receipt, err := RequestAgentDSHCancellation(context.Background(), sessionID, requestID)
			require.NoError(t, err)
			assert.Equal(t, status, receipt.Status)
			assert.Nil(t, receipt.Turn)
		})
	}
}
