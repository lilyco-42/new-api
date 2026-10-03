package controller

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func TestAgentDSHSearchEmptyResultReportsMissingEvidence(t *testing.T) {
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Empty(t, r.Header.Get("Authorization"))
		require.Empty(t, r.Header.Get("Cookie"))
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
