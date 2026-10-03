package controller

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestAgentDSHSearchEmptyResultReportsMissingEvidence(t *testing.T) {
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Empty(t, r.Header.Get("Authorization"))
		assert.Empty(t, r.Header.Get("Cookie"))
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"results":[]}`))
	}))
	defer source.Close()
	t.Setenv("AGENT_WEB_SEARCH_URL", source.URL)
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest(http.MethodPost, "/api/agent/dsh/tool-dispatch", nil)
	result, code, message := executeAgentDSHTool(c, "web_search", map[string]any{"query": "official project repository"})

	require.Nil(t, result, "empty results must not be presented as retrieved evidence")
	require.Equal(t, "search_no_results", code)
	require.Contains(t, message, "No search results")
	require.Contains(t, message, "Do not repeat")
}

func TestAgentDSHSearchPreservesEvidenceAndProviderFailure(t *testing.T) {
	for _, test := range []struct {
		name   string
		status int
		body   string
		code   string
	}{
		{"retrieved source", http.StatusOK, `{"results":[{"title":"Project","url":"https://example.org/project","content":"Public project description"}]}`, ""},
		{"upstream unavailable", http.StatusServiceUnavailable, `{"error":"unavailable"}`, "search_unavailable"},
	} {
		t.Run(test.name, func(t *testing.T) {
			source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				assert.Empty(t, r.Header.Get("Authorization"))
				assert.Empty(t, r.Header.Get("Cookie"))
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(test.status)
				_, _ = w.Write([]byte(test.body))
			}))
			defer source.Close()
			t.Setenv("AGENT_WEB_SEARCH_URL", source.URL)
			c, _ := gin.CreateTestContext(httptest.NewRecorder())
			c.Request = httptest.NewRequest(http.MethodPost, "/api/agent/dsh/tool-dispatch", nil)
			result, code, message := executeAgentDSHTool(c, "web_search", map[string]any{"query": "project"})
			require.Equal(t, test.code, code)
			if code != "" {
				require.Nil(t, result)
				require.Contains(t, message, "temporarily unavailable")
				return
			}
			require.Empty(t, message)
			evidence, ok := result.(gin.H)
			require.True(t, ok)
			items, ok := evidence["items"].([]agentWebSearchItem)
			require.True(t, ok)
			require.Len(t, items, 1)
			require.Equal(t, "https://example.org/project", items[0].URL)
			require.Equal(t, "Public project description", items[0].Snippet)
		})
	}
}
