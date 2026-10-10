package controller

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestAgentPublicGitHubQueryPreservesSourceAndQualifiers(t *testing.T) {
	for _, test := range []struct {
		query string
		want  string
	}{
		{"find GitHub official cli/cli repository", "cli/cli"},
		{"site:github.com rust language:rust stars:>100", "rust language:rust stars:>100"},
		{"GitHub 查找 官方 wasm 仓库", "wasm"},
		{`GitHub "terminal tools" language:rust`, `"terminal tools" language:rust`},
		{"rust community news", ""},
		{"site:github.com.example.org credentials", ""},
		{"notgithub project", ""},
		{"GitHub official repositories", ""},
	} {
		t.Run(test.query, func(t *testing.T) {
			assert.Equal(t, test.want, agentPublicGitHubQuery(test.query))
		})
	}
}

func TestPublicRepositorySearchSharedByHTTPAndDSHWithoutOAuth(t *testing.T) {
	for _, test := range []struct {
		name       string
		status     int
		body       string
		httpStatus int
		toolCode   string
	}{
		{"public evidence only", http.StatusOK, `{"incomplete_results":false,"items":[{"full_name":"cli/cli","html_url":"https://github.com/cli/cli","description":"<b>GitHub CLI</b>","private":false},{"full_name":"owner/private","html_url":"https://github.com/owner/private","private":true},{"full_name":"owner/unknown","html_url":"https://github.com/owner/unknown"},{"full_name":"owner/unsafe","html_url":"https://example.org/unsafe","private":false}]}`, http.StatusOK, ""},
		{"empty evidence", http.StatusOK, `{"incomplete_results":false,"items":[]}`, http.StatusOK, "search_no_results"},
		{"incomplete evidence", http.StatusOK, `{"incomplete_results":true,"items":[]}`, http.StatusBadGateway, "search_unavailable"},
		{"invalid envelope", http.StatusOK, `{}`, http.StatusBadGateway, "search_unavailable"},
		{"invalid JSON", http.StatusOK, `<html>login</html>`, http.StatusBadGateway, "search_unavailable"},
		{"rate limited", http.StatusTooManyRequests, `{"message":"rate limit"}`, http.StatusBadGateway, "search_unavailable"},
		{"oversized response", http.StatusOK, strings.Repeat(" ", 1<<20+1), http.StatusBadGateway, "search_unavailable"},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Setenv("AGENT_WEB_SEARCH_URL", "")
			previous := http.DefaultTransport
			requests := 0
			http.DefaultTransport = agentGitHubRoundTripper(func(request *http.Request) (*http.Response, error) {
				requests++
				assert.Equal(t, http.MethodGet, request.Method)
				assert.Equal(t, "https", request.URL.Scheme)
				assert.Equal(t, "api.github.com", request.URL.Host)
				assert.Equal(t, "/search/repositories", request.URL.Path)
				assert.Equal(t, "cli/cli", request.URL.Query().Get("q"))
				assert.Equal(t, "2", request.URL.Query().Get("per_page"))
				assert.Empty(t, request.Header.Get("Authorization"))
				assert.Empty(t, request.Header.Get("Cookie"))
				return &http.Response{StatusCode: test.status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(test.body))}, nil
			})
			t.Cleanup(func() { http.DefaultTransport = previous })

			recorder := httptest.NewRecorder()
			c, _ := gin.CreateTestContext(recorder)
			c.Set("id", 42) // No credential lookup or database is required.
			c.Request = httptest.NewRequest(http.MethodGet, "/api/agent/web/search?q=GitHub+cli%2Fcli+official+repository&limit=2", nil)
			AgentWebSearch(c)
			require.Equal(t, test.httpStatus, recorder.Code)
			result, code, _ := executeAgentDSHTool(c, "web_search", map[string]any{"query": "GitHub cli/cli official repository", "limit": 2})
			require.Equal(t, test.toolCode, code)
			assert.Equal(t, 2, requests, "one request per consumer; no retries or credential fallback")
			if code != "" {
				require.Nil(t, result)
				return
			}
			data, ok := result.(gin.H)
			require.True(t, ok)
			assert.Equal(t, "github-public", data["provider"])
			assert.Equal(t, "https://github.com/search?type=repositories&q=cli%2Fcli", data["search_url"])
			items, ok := data["items"].([]agentWebSearchItem)
			require.True(t, ok)
			require.Len(t, items, 1)
			assert.Equal(t, agentWebSearchItem{Title: "cli/cli", URL: "https://github.com/cli/cli", Snippet: "GitHub CLI", Source: "github.com"}, items[0])
			assert.NotContains(t, recorder.Body.String(), "owner/private")
		})
	}
}

func TestPublicSearchKeepsBroadWebAndConfiguredProvider(t *testing.T) {
	for _, test := range []struct {
		name     string
		query    string
		endpoint string
		host     string
		provider string
		body     string
	}{
		{"broad web", "Rust community news", "", "www.bing.com", "bing", `<rss><channel><item><title>Rust community</title><link>https://rustcc.cn/</link></item></channel></rss>`},
		{"configured override", "GitHub cli/cli", "https://search.example.org/search", "search.example.org", "searxng", `{"results":[{"title":"Rust community","url":"https://rustcc.cn/"}]}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Setenv("AGENT_WEB_SEARCH_URL", test.endpoint)
			previous := http.DefaultTransport
			http.DefaultTransport = agentGitHubRoundTripper(func(request *http.Request) (*http.Response, error) {
				assert.Equal(t, test.host, request.URL.Host)
				assert.Equal(t, test.query, request.URL.Query().Get("q"))
				assert.Empty(t, request.Header.Get("Authorization"))
				assert.Empty(t, request.Header.Get("Cookie"))
				return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(test.body))}, nil
			})
			t.Cleanup(func() { http.DefaultTransport = previous })
			provider, items, _, err := searchAgentPublicSources(context.Background(), test.query, 1)
			require.NoError(t, err)
			assert.Equal(t, test.provider, provider)
			require.Len(t, items, 1)
			assert.Equal(t, "https://rustcc.cn/", items[0].URL)
		})
	}
}

func TestPublicSearchRejectsOversizedQueriesBeforeAnyRequest(t *testing.T) {
	previous := http.DefaultTransport
	http.DefaultTransport = agentGitHubRoundTripper(func(request *http.Request) (*http.Response, error) {
		t.Fatal("invalid query must not reach a public or account provider")
		return nil, nil
	})
	t.Cleanup(func() { http.DefaultTransport = previous })
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	query := strings.Repeat("x", maxAgentSearchQuery+1)
	c.Request = httptest.NewRequest(http.MethodGet, "/api/agent/web/search?q="+query, nil)
	AgentWebSearch(c)
	require.Equal(t, http.StatusBadRequest, recorder.Code)
	result, code, _ := executeAgentDSHTool(c, "web_search", map[string]any{"query": query})
	require.Nil(t, result)
	assert.Equal(t, "invalid_arguments", code)
}
