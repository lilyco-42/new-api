package controller

import (
	"encoding/base64"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestGitHubContentRelayUsesTheOwnedRequestCredentialAndScope(t *testing.T) {
	setupAgentIssueReadTest(t)
	session, err := model.CreateAgentDSHSession(42, time.Time{})
	require.NoError(t, err)
	ids := []string{"123e4567-e89b-42d3-a456-426614174000", "123e4567-e89b-42d3-a456-426614174001", "123e4567-e89b-42d3-a456-426614174002"}
	for i, scope := range []string{"account-read", "public-only", "evidence-only"} {
		_, err := model.ReserveOwnedAgentDSHRequestWithToolScope(42, session.SessionId, ids[i], scope, time.Time{})
		require.NoError(t, err)
	}
	previous := http.DefaultTransport
	requests := 0
	commit := strings.Repeat("a", 40)
	http.DefaultTransport = agentGitHubRoundTripper(func(r *http.Request) (*http.Response, error) {
		requests++
		assert.Equal(t, "Bearer account-42-token", r.Header.Get("Authorization"))
		body := `[{"sha":"` + commit + `"}]`
		if strings.Contains(r.URL.Path, "/contents/") {
			assert.Equal(t, commit, r.URL.Query().Get("ref"))
			content := "fn persist_manifest() {}"
			encoded, marshalErr := common.Marshal(map[string]any{"type": "file", "path": "src/batch.rs", "sha": commit,
				"size": len(content), "encoding": "base64", "content": base64.StdEncoding.EncodeToString([]byte(content))})
			require.NoError(t, marshalErr)
			body = string(encoded)
		}
		return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}, nil
	})
	t.Cleanup(func() { http.DefaultTransport = previous })
	send := func(user int, requestID, filePath string) *httptest.ResponseRecorder {
		body, marshalErr := common.Marshal(map[string]any{"version": 2, "session_id": session.SessionId, "request_id": requestID,
			"tool": "github_content", "arguments": map[string]any{"repo": "owner/project", "path": filePath}})
		require.NoError(t, marshalErr)
		response := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(response)
		c.Request = httptest.NewRequest(http.MethodPost, "/api/agent/bridge/v1/tool", strings.NewReader(string(body)))
		c.Set("id", user)
		AgentDSHToolRelay(c)
		return response
	}
	response := send(42, ids[0], "src/batch.rs")
	require.Equal(t, http.StatusOK, response.Code)
	assert.Contains(t, response.Body.String(), "fn persist_manifest() {}")
	assert.Contains(t, response.Body.String(), "/blob/"+commit+"/src/batch.rs")
	assert.NotContains(t, response.Body.String(), "account-42-token")
	assert.Equal(t, 2, requests)
	assert.Contains(t, send(43, ids[0], "src/batch.rs").Body.String(), "tool_request_not_admitted")
	assert.Contains(t, send(42, ids[1], "src/batch.rs").Body.String(), "tool_scope_denied")
	assert.Contains(t, send(42, ids[2], "src/batch.rs").Body.String(), "tool_scope_denied")
	assert.Contains(t, send(42, ids[0], "../private").Body.String(), "invalid_arguments")
	assert.Equal(t, 2, requests, "foreign requests, denied scopes and traversal must not read GitHub")
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest(http.MethodPost, "/api/agent/bridge/v1/tool", nil)
	c.Set("id", 43)
	_, code, _ := executeAgentDSHTool(c, "github_content", map[string]any{"repo": "owner/project", "path": "src/batch.rs"})
	assert.Equal(t, "github_not_connected", code)
	assert.Equal(t, 2, requests)
}
