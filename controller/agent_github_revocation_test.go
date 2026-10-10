package controller

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func TestAgentGitHubReadFailureRefreshesOnlyTheRejectedGrant(t *testing.T) {
	tests := []struct {
		name      string
		status    int
		rotate    bool
		connected bool
	}{
		{name: "rejected authorization disconnects only GitHub", status: http.StatusUnauthorized},
		{name: "late rejection preserves a reconnected grant", status: http.StatusUnauthorized, rotate: true, connected: true},
		{name: "permission denial preserves the grant", status: http.StatusForbidden, connected: true},
		{name: "rate limit preserves the grant", status: http.StatusTooManyRequests, connected: true},
		{name: "missing repository preserves the grant", status: http.StatusNotFound, connected: true},
		{name: "upstream outage preserves the grant", status: http.StatusServiceUnavailable, connected: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			setupAgentIssueReadTest(t)
			require.NoError(t, model.SaveAgentGitHubCredential(77, "provider-77", "other", "repo", "other-account-token"))
			previousTransport := http.DefaultTransport
			http.DefaultTransport = agentGitHubRoundTripper(func(request *http.Request) (*http.Response, error) {
				assert.Equal(t, "api.github.com", request.URL.Hostname())
				assert.Equal(t, "Bearer account-42-token", request.Header.Get("Authorization"))
				if test.rotate {
					require.NoError(t, model.SaveAgentGitHubCredential(42, "provider-42", "owner", "repo", "reconnected-account-token"))
				}
				return &http.Response{
					StatusCode: test.status,
					Header:     make(http.Header),
					Body:       io.NopCloser(strings.NewReader(`{"message":"GitHub request failed"}`)),
				}, nil
			})
			t.Cleanup(func() { http.DefaultTransport = previousTransport })
			requestContext, _ := gin.CreateTestContext(httptest.NewRecorder())
			requestContext.Request = httptest.NewRequest(http.MethodGet, "/api/agent/github/repositories", nil)
			requestContext.Set("id", 42)
			var repositories []agentGitHubRepository
			err := agentGitHubRequest(requestContext, http.MethodGet, "https://api.github.com/user/repos", nil, &repositories)
			require.Error(t, err)
			assert.Empty(t, repositories, "a failed read must not invent repository data")
			statusResponse := httptest.NewRecorder()
			statusContext, _ := gin.CreateTestContext(statusResponse)
			statusContext.Request = httptest.NewRequest(http.MethodGet, "/api/agent/github/status", nil)
			statusContext.Set("id", 42)
			AgentGitHubStatus(statusContext)
			require.Equal(t, http.StatusOK, statusResponse.Code)
			var status struct {
				Success bool `json:"success"`
				Data    agentGitHubStatus `json:"data"`
			}
			require.NoError(t, common.Unmarshal(statusResponse.Body.Bytes(), &status))
			require.True(t, status.Success)
			assert.Equal(t, test.connected, status.Data.Connected, "connection status must reflect rejected authorization, not just the presence of stored data")
			_, token, credentialErr := model.GetAgentGitHubCredential(42)
			if !test.connected {
				assert.ErrorIs(t, credentialErr, gorm.ErrRecordNotFound)
				assert.Empty(t, token)
			} else {
				require.NoError(t, credentialErr)
				expected := "account-42-token"
				if test.rotate {
					expected = "reconnected-account-token"
				}
				assert.Equal(t, expected, token)
			}
			_, otherToken, err := model.GetAgentGitHubCredential(77)
			require.NoError(t, err)
			assert.Equal(t, "other-account-token", otherToken)
			assert.NotContains(t, statusResponse.Body.String(), "account-42-token")
			assert.NotContains(t, statusResponse.Body.String(), "reconnected-account-token")
			assert.NotContains(t, statusResponse.Body.String(), "other-account-token")
		})
	}
}
