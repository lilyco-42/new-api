package controller

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestAgentGitHubActivityReturnsBodyAndKeepsIssuesSeparateFromPulls(t *testing.T) {
	for _, resource := range []string{"issues", "pull-requests"} {
		t.Run(resource, func(t *testing.T) {
			previousTransport := http.DefaultTransport
			http.DefaultTransport = agentGitHubRoundTripper(func(request *http.Request) (*http.Response, error) {
				assert.Equal(t, "merchant/image-workflow", strings.TrimPrefix(strings.TrimSuffix(request.URL.Path, "/"+map[string]string{"issues": "issues", "pull-requests": "pulls"}[resource]), "/repos/"))
				return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header),
					Body: io.NopCloser(strings.NewReader(`[
					{"number":17,"title":"Replay export","html_url":"https://github.com/merchant/image-workflow/issues/17","body":"After reconnect the same export downloads twice.","state":"open"},
					{"number":18,"title":"Pull only","html_url":"https://github.com/merchant/image-workflow/pull/18","body":"Add a durable idempotency key.","state":"open","pull_request":{}}
					]`))}, nil
			})
			t.Cleanup(func() { http.DefaultTransport = previousTransport })
			recorder := httptest.NewRecorder()
			c, _ := gin.CreateTestContext(recorder)
			c.Request = httptest.NewRequest(http.MethodGet, "/api/agent/github/"+resource+"?repo=merchant/image-workflow&limit=3", nil)
			c.Set("id", 0)
			if resource == "issues" {
				AgentGitHubIssues(c)
			} else {
				AgentGitHubPullRequests(c)
			}
			require.Equal(t, http.StatusOK, recorder.Code)
			var response struct {
				Data struct {
					Items []map[string]any `json:"items"`
				} `json:"data"`
			}
			require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &response))
			require.NotEmpty(t, response.Data.Items)
			assert.Equal(t, "After reconnect the same export downloads twice.", response.Data.Items[0]["body"])
			assert.Equal(t, "https://github.com/merchant/image-workflow/issues/17", response.Data.Items[0]["url"])
			if resource == "issues" {
				assert.Len(t, response.Data.Items, 1)
			} else {
				assert.Len(t, response.Data.Items, 2)
				assert.Equal(t, "Add a durable idempotency key.", response.Data.Items[1]["body"])
			}
		})
	}
}

func TestAgentDSHGitHubActivityUsesTheSameBodyContractAndAccountCredential(t *testing.T) {
	setupAgentDSHControllerTest(t)
	require.NoError(t, model.DB.AutoMigrate(&model.AgentGitHubCredential{}))
	previousSecret := common.CryptoSecret
	common.CryptoSecret = "isolated-activity-contract-test-secret"
	t.Cleanup(func() { common.CryptoSecret = previousSecret })
	require.NoError(t, model.SaveAgentGitHubCredential(42, "test-provider-id", "test-owner", "repo", "test-owner-credential"))
	previousTransport := http.DefaultTransport
	requestCount := 0
	http.DefaultTransport = agentGitHubRoundTripper(func(request *http.Request) (*http.Response, error) {
		requestCount++
		assert.Equal(t, "Bearer test-owner-credential", request.Header.Get("Authorization"))
		return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`[
		{"number":17,"title":"Replay export","html_url":"https://github.com/merchant/image-workflow/issues/17","body":"Reconnection repeats the completed export."},
		{"number":18,"title":"Pull only","html_url":"https://github.com/merchant/image-workflow/pull/18","body":"Persist the export request ID.","pull_request":{}}
		]`))}, nil
	})
	t.Cleanup(func() { http.DefaultTransport = previousTransport })
	for _, tool := range []string{"github_issues", "github_pull_requests"} {
		c, _ := gin.CreateTestContext(httptest.NewRecorder())
		c.Request = httptest.NewRequest(http.MethodPost, "/api/agent/dsh/tools", nil)
		c.Set("id", 42)
		result, code, _ := executeAgentDSHTool(c, tool, map[string]any{"repo": "merchant/image-workflow", "limit": 3})
		require.Empty(t, code)
		data, ok := result.(gin.H)
		require.True(t, ok)
		items, ok := data["items"].([]agentGitHubActivity)
		require.True(t, ok)
		require.NotEmpty(t, items)
		assert.Equal(t, "Reconnection repeats the completed export.", items[0].Body)
		if tool == "github_issues" {
			assert.Len(t, items, 1)
		} else {
			require.Len(t, items, 2)
			assert.Equal(t, "Persist the export request ID.", items[1].Body)
		}
		encoded, err := json.Marshal(result)
		require.NoError(t, err)
		assert.NotContains(t, string(encoded), "test-owner-credential")
	}
	requestsBefore := requestCount
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest(http.MethodPost, "/api/agent/dsh/tools", nil)
	c.Set("id", 43)
	_, code, _ := executeAgentDSHTool(c, "github_issues", map[string]any{"repo": "merchant/image-workflow"})
	assert.Equal(t, "github_not_connected", code)
	assert.Equal(t, requestsBefore, requestCount, "another account must not inherit the connected account's credential")
}

func TestAgentGitHubActivityBoundsBodyWithoutBreakingUTF8(t *testing.T) {
	previousTransport := http.DefaultTransport
	body := strings.Repeat("修复", 3000)
	upstream, err := json.Marshal([]map[string]any{{"number": 17, "title": "Large report", "html_url": "https://github.com/merchant/image-workflow/issues/17", "body": body}})
	require.NoError(t, err)
	http.DefaultTransport = agentGitHubRoundTripper(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(string(upstream)))}, nil
	})
	t.Cleanup(func() { http.DefaultTransport = previousTransport })
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(http.MethodGet, "/api/agent/github/issues?repo=merchant/image-workflow", nil)
	c.Set("id", 0)
	AgentGitHubIssues(c)
	require.Equal(t, http.StatusOK, recorder.Code)
	var response struct {
		Data struct {
			Items []map[string]any `json:"items"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &response))
	require.Len(t, response.Data.Items, 1)
	text, ok := response.Data.Items[0]["body"].(string)
	require.True(t, ok, "Issue content must be available to the model")
	assert.NotEmpty(t, text)
	assert.LessOrEqual(t, len(text), 4096)
	assert.True(t, utf8.ValidString(text))
	assert.True(t, strings.HasPrefix(body, text))
	assert.Equal(t, true, response.Data.Items[0]["body_truncated"])
}
