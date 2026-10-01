package controller

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"unicode/utf8"

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
