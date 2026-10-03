package controller

import (
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

// The public browser instruction must become an immutable permission bound to
// the admitted request, not a mutable session flag or a model prompt alone.
func TestAgentDSHPublicTurnScopeIsForwardedAndCannotBeWidenedOnRetry(t *testing.T) {
	setupAgentDSHControllerTest(t)
	gin.SetMode(gin.TestMode)
	session, err := model.CreateAgentDSHSession(42, time.Now().UTC())
	require.NoError(t, err)
	t.Setenv("LAIN42_DSH_BRIDGE_SECRET", strings.Repeat("s", 32))
	var forwarded []map[string]any
	runtime := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, readErr := io.ReadAll(r.Body)
		assert.NoError(t, readErr)
		var wire map[string]any
		assert.NoError(t, common.Unmarshal(body, &wire))
		forwarded = append(forwarded, wire)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"version":1,"requestId":"123e4567-e89b-42d3-a456-426614174000","answer":"actual runtime result"}`)
	}))
	defer runtime.Close()
	t.Setenv("LAIN42_DSH_BASE_URL", runtime.URL)
	send := func(scope string, userID int) *httptest.ResponseRecorder {
		body, marshalErr := common.Marshal(map[string]any{
			"session_id": session.SessionId, "request_id": "123e4567-e89b-42d3-a456-426614174000",
			"model": "gateway-model", "text": "Search the public web, not my account.", "tool_scope": scope,
		})
		require.NoError(t, marshalErr)
		recorder := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(recorder)
		c.Request = httptest.NewRequest(http.MethodPost, "/api/agent/dsh/turns", strings.NewReader(string(body)))
		c.Set("id", userID)
		AgentDSHTurn(c)
		return recorder
	}
	require.Equal(t, http.StatusOK, send("public-only", 42).Code)
	require.Len(t, forwarded, 1)
	assert.EqualValues(t, 3, forwarded[0]["version"], "older DSH must reject required scope rather than ignore an extra field")
	assert.Equal(t, "public-only", forwarded[0]["toolScope"])
	assert.Equal(t, http.StatusOK, send("public-only", 42).Code)
	changed := send("account-read", 42)
	assert.Equal(t, http.StatusConflict, changed.Code)
	assert.Contains(t, changed.Body.String(), "AGENT_DSH_REQUEST_CONFLICT")
	assert.Equal(t, http.StatusBadRequest, send("shell-all", 42).Code)
	assert.Equal(t, http.StatusNotFound, send("public-only", 43).Code)
	assert.Len(t, forwarded, 2, "policy widening and foreign ownership must not cross the runtime boundary")
}

func TestAgentDSHScopedToolRelayRejectsLegacyAndUnadmittedCallsBeforeGitHub(t *testing.T) {
	setupAgentIssueReadTest(t)
	gin.SetMode(gin.TestMode)
	session, err := model.CreateAgentDSHSession(42, time.Now().UTC())
	require.NoError(t, err)
	t.Setenv("LAIN42_DSH_BRIDGE_SECRET", strings.Repeat("s", 32))
	runtime := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"version":1,"requestId":"123e4567-e89b-42d3-a456-426614174000","answer":"public answer"}`)
	}))
	defer runtime.Close()
	t.Setenv("LAIN42_DSH_BASE_URL", runtime.URL)
	body, err := common.Marshal(map[string]any{
		"session_id": session.SessionId, "request_id": "123e4567-e89b-42d3-a456-426614174000",
		"model": "gateway-model", "text": "Only public sources", "tool_scope": "public-only",
	})
	require.NoError(t, err)
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(http.MethodPost, "/api/agent/dsh/turns", strings.NewReader(string(body)))
	c.Set("id", 42)
	AgentDSHTurn(c)
	require.Equal(t, http.StatusOK, recorder.Code)
	previousTransport := http.DefaultTransport
	githubReads := 0
	http.DefaultTransport = agentGitHubRoundTripper(func(r *http.Request) (*http.Response, error) {
		githubReads++
		return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`[]`))}, nil
	})
	t.Cleanup(func() { http.DefaultTransport = previousTransport })
	for _, test := range []struct {
		name      string
		version   int
		requestID string
		userID    int
		code      string
	}{
		{"explicit public turn rejects account tool", 2, "123e4567-e89b-42d3-a456-426614174000", 42, "tool_scope_denied"},
		{"legacy peer cannot omit exact request", 1, "", 42, "tool_request_identity_required"},
		{"unadmitted request", 2, "123e4567-e89b-42d3-a456-426614174001", 42, "tool_request_not_admitted"},
		{"another account", 2, "123e4567-e89b-42d3-a456-426614174000", 43, "tool_request_not_admitted"},
	} {
		t.Run(test.name, func(t *testing.T) {
			payload, marshalErr := common.Marshal(map[string]any{
				"version": test.version, "session_id": session.SessionId, "request_id": test.requestID,
				"tool": "github_repositories", "arguments": map[string]any{"limit": 5},
			})
			require.NoError(t, marshalErr)
			response := httptest.NewRecorder()
			context, _ := gin.CreateTestContext(response)
			context.Request = httptest.NewRequest(http.MethodPost, "/api/agent/bridge/v1/tool", strings.NewReader(string(payload)))
			context.Set("id", test.userID)
			AgentDSHToolRelay(context)
			assert.Equal(t, http.StatusOK, response.Code, "scope failure is a structured tool result, not a fatal model transport error")
			assert.Contains(t, response.Body.String(), test.code)
			assert.Zero(t, githubReads, "denied execution must not send account credentials to GitHub")
		})
	}
}

func TestAgentDSHScopedToolRelayKeepsLaterAccountReadsSeparateFromPublicAndStoppedTurns(t *testing.T) {
	setupAgentIssueReadTest(t)
	gin.SetMode(gin.TestMode)
	session, err := model.CreateAgentDSHSession(42, time.Time{})
	require.NoError(t, err)
	ids := []string{"123e4567-e89b-42d3-a456-426614174000", "123e4567-e89b-42d3-a456-426614174001", "123e4567-e89b-42d3-a456-426614174002"}
	for index, scope := range []string{"public-only", "account-read", "evidence-only"} {
		_, err := model.ReserveOwnedAgentDSHRequestWithToolScope(42, session.SessionId, ids[index], scope, time.Time{})
		require.NoError(t, err)
	}
	previousTransport := http.DefaultTransport
	githubReads := 0
	http.DefaultTransport = agentGitHubRoundTripper(func(r *http.Request) (*http.Response, error) {
		if r.URL.Hostname() != "api.github.com" {
			return previousTransport.RoundTrip(r)
		}
		githubReads++
		assert.Equal(t, "Bearer account-42-token", r.Header.Get("Authorization"))
		return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`[]`))}, nil
	})
	t.Cleanup(func() { http.DefaultTransport = previousTransport })
	publicReads := 0
	search := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		publicReads++
		assert.Empty(t, r.Header.Get("Authorization"))
		assert.Empty(t, r.Header.Get("Cookie"))
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"results":[{"title":"public reference","url":"https://example.com/reference","content":"Public evidence."}]}`)
	}))
	defer search.Close()
	t.Setenv("AGENT_WEB_SEARCH_URL", search.URL)
	send := func(requestID, tool string) string {
		body, marshalErr := common.Marshal(map[string]any{
			"version": 2, "session_id": session.SessionId, "request_id": requestID,
			"tool": tool, "arguments": map[string]any{"query": "public reference", "limit": 5},
		})
		require.NoError(t, marshalErr)
		response := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(response)
		c.Request = httptest.NewRequest(http.MethodPost, "/api/agent/bridge/v1/tool", strings.NewReader(string(body)))
		c.Set("id", 42)
		AgentDSHToolRelay(c)
		require.Equal(t, http.StatusOK, response.Code)
		return response.Body.String()
	}
	assert.Contains(t, send(ids[0], "web_search"), "https://example.com/reference")
	assert.Equal(t, 1, publicReads)
	assert.Zero(t, githubReads)
	assert.Contains(t, send(ids[2], "web_search"), "tool_scope_denied")
	assert.Contains(t, send(ids[0], "unregistered_shell"), "tool_scope_denied")
	assert.Contains(t, send(ids[1], "github_repositories"), `"result"`)
	assert.Equal(t, 1, githubReads, "only the separate account-authorized request may read account data")
	assert.Contains(t, send(ids[0], "github_repositories"), "tool_scope_denied", "later account authorization cannot widen the old public request")
	assert.Contains(t, send(ids[1], "unregistered_shell"), "tool_not_available", "account-read cannot grant an unregistered tool")
	_, err = model.RequestOwnedAgentDSHCancellation(42, session.SessionId, ids[0], time.Time{})
	require.NoError(t, err)
	assert.Contains(t, send(ids[0], "web_search"), "tool_request_cancelled")
	assert.Equal(t, 1, publicReads, "cancellation must reject before starting another search")
	assert.Equal(t, 1, githubReads)
}
