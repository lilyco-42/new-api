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

func setupAgentIssueReadTest(t *testing.T) {
	t.Helper()
	setupAgentDSHControllerTest(t)
	require.NoError(t, model.DB.AutoMigrate(&model.AgentGitHubCredential{}))
	previousSecret := common.CryptoSecret
	common.CryptoSecret = "isolated-single-issue-read-test-secret"
	t.Cleanup(func() { common.CryptoSecret = previousSecret })
	require.NoError(t, model.SaveAgentGitHubCredential(42, "provider-42", "owner", "repo", "account-42-token"))
}

func TestAgentIssueReadReturnsTheSelectedClosedIssueAndBoundedComments(t *testing.T) {
	setupAgentIssueReadTest(t)
	previousTransport := http.DefaultTransport
	requests := 0
	http.DefaultTransport = agentGitHubRoundTripper(func(request *http.Request) (*http.Response, error) {
		requests++
		assert.Equal(t, "Bearer account-42-token", request.Header.Get("Authorization"))
		var result any
		if requests == 1 {
			assert.Equal(t, "/repos/owner/project/issues/2", request.URL.Path)
			result = map[string]any{"number": 2, "title": "Reconnect", "state": "closed", "comments": 4,
				"html_url": "https://github.com/owner/project/issues/2", "body": strings.Repeat("修复", 3000)}
		} else {
			assert.Equal(t, "/repos/owner/project/issues/2/comments", request.URL.Path)
			assert.Equal(t, "3", request.URL.Query().Get("per_page"))
			result = []map[string]any{
				{"body": "Still fails after losing the response.", "user": map[string]string{"login": "maintainer"}},
				{"body": strings.Repeat("评论", 1000)},
				{"body": "Persist the export request ID."},
			}
		}
		encoded, err := common.Marshal(result)
		require.NoError(t, err)
		return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(string(encoded)))}, nil
	})
	t.Cleanup(func() { http.DefaultTransport = previousTransport })
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(http.MethodGet, "/api/agent/github/issue?repo=owner/project&number=2", nil)
	c.Set("id", 42)
	AgentGitHubIssueRead(c)
	require.Equal(t, http.StatusOK, recorder.Code)
	var response struct {
		Data struct {
			Items             []agentGitHubActivity     `json:"items"`
			Comments          []agentGitHubIssueComment `json:"comments"`
			CommentsTruncated bool                      `json:"comments_truncated"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &response))
	require.Len(t, response.Data.Items, 1)
	assert.Equal(t, 2, response.Data.Items[0].Number)
	assert.Equal(t, "closed", response.Data.Items[0].State)
	assert.LessOrEqual(t, len(response.Data.Items[0].Body), 12*1024)
	assert.True(t, response.Data.Items[0].BodyTruncated)
	assert.True(t, utf8.ValidString(response.Data.Items[0].Body))
	require.Len(t, response.Data.Comments, 3)
	assert.Equal(t, "maintainer", response.Data.Comments[0].Author)
	assert.True(t, response.Data.Comments[1].BodyTruncated)
	assert.True(t, utf8.ValidString(response.Data.Comments[1].Body))
	assert.LessOrEqual(t, len(response.Data.Comments[1].Body), 2*1024)
	assert.True(t, response.Data.CommentsTruncated)
	assert.NotContains(t, recorder.Body.String(), "account-42-token")
	assert.Equal(t, 2, requests)

	for _, scenario := range []struct {
		query           string
		account, status int
	}{
		{"repo=owner/project&number=2", 43, http.StatusUnauthorized},
		{"repo=owner/project&number=0", 42, http.StatusBadRequest},
		{"repo=owner/project&number=2147483648", 42, http.StatusBadRequest},
		{"repo=owner/..&number=2", 42, http.StatusBadRequest},
	} {
		rejected := httptest.NewRecorder()
		context, _ := gin.CreateTestContext(rejected)
		context.Request = httptest.NewRequest(http.MethodGet, "/api/agent/github/issue?"+scenario.query, nil)
		context.Set("id", scenario.account)
		AgentGitHubIssueRead(context)
		assert.Equal(t, scenario.status, rejected.Code)
	}
	assert.Equal(t, 2, requests, "unlinked accounts and invalid targets must not cause GitHub requests")
}

func TestAgentIssueReadKeepsTheBodyButReportsFailedCommentReads(t *testing.T) {
	setupAgentIssueReadTest(t)
	previousTransport := http.DefaultTransport
	http.DefaultTransport = agentGitHubRoundTripper(func(request *http.Request) (*http.Response, error) {
		if strings.HasSuffix(request.URL.Path, "/comments") {
			return &http.Response{StatusCode: http.StatusForbidden, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{}`))}, nil
		}
		return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"number":2,"title":"Reconnect","body":"Body was read.","comments":1,"html_url":"https://github.com/owner/project/issues/2"}`))}, nil
	})
	t.Cleanup(func() { http.DefaultTransport = previousTransport })
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(http.MethodGet, "/api/agent/github/issue?repo=owner/project&number=2", nil)
	c.Set("id", 42)
	AgentGitHubIssueRead(c)
	require.Equal(t, http.StatusOK, recorder.Code)
	assert.Contains(t, recorder.Body.String(), "Body was read.")
	assert.Contains(t, recorder.Body.String(), `"comments_truncated":true`)
	assert.Contains(t, recorder.Body.String(), "GitHub issue comments could not be read")
}

func TestAgentIssueReadPreservesUpstreamAuthorizationAndNotFoundFailures(t *testing.T) {
	for _, status := range []int{http.StatusUnauthorized, http.StatusNotFound} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			setupAgentIssueReadTest(t)
			previousTransport := http.DefaultTransport
			t.Cleanup(func() { http.DefaultTransport = previousTransport })
			http.DefaultTransport = agentGitHubRoundTripper(func(*http.Request) (*http.Response, error) {
				return &http.Response{StatusCode: status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{}`))}, nil
			})
			recorder := httptest.NewRecorder()
			c, _ := gin.CreateTestContext(recorder)
			c.Request = httptest.NewRequest(http.MethodGet, "/api/agent/github/issue?repo=owner/project&number=2", nil)
			c.Set("id", 42)
			AgentGitHubIssueRead(c)
			assert.Equal(t, status, recorder.Code)
			assert.NotContains(t, recorder.Body.String(), `"items"`)
		})
	}
}

func TestAgentDSHIssueReadUsesTheMappedAccountAndReturnsExactDiscussion(t *testing.T) {
	setupAgentIssueReadTest(t)
	previousTransport := http.DefaultTransport
	requests := 0
	http.DefaultTransport = agentGitHubRoundTripper(func(request *http.Request) (*http.Response, error) {
		requests++
		assert.Equal(t, "Bearer account-42-token", request.Header.Get("Authorization"))
		body := `{"number":2,"title":"Reconnect","state":"closed","body":"Export is duplicated.","comments":1,"html_url":"https://github.com/owner/project/issues/2"}`
		if strings.HasSuffix(request.URL.Path, "/comments") {
			body = `[{"body":"The response is lost before retry.","html_url":"https://github.com/owner/project/issues/2#issuecomment-1","user":{"login":"maintainer"}}]`
		} else {
			assert.Equal(t, "/repos/owner/project/issues/2", request.URL.Path)
		}
		return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}, nil
	})
	t.Cleanup(func() { http.DefaultTransport = previousTransport })
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest(http.MethodPost, "/api/agent/bridge/v1/tool", nil)
	c.Set("id", 42)
	result, code, message := executeAgentDSHTool(c, "github_issue", map[string]any{"repo": "owner/project", "number": float64(2)})
	require.Empty(t, code, message)
	encoded, err := common.Marshal(result)
	require.NoError(t, err)
	assert.Contains(t, string(encoded), "Export is duplicated.")
	assert.Contains(t, string(encoded), "The response is lost before retry.")
	assert.Contains(t, string(encoded), `"state":"closed"`)
	assert.NotContains(t, string(encoded), "account-42-token")
	assert.Equal(t, 2, requests)

	c.Set("id", 43)
	result, code, _ = executeAgentDSHTool(c, "github_issue", map[string]any{"repo": "owner/project", "number": float64(2)})
	assert.Nil(t, result)
	assert.Equal(t, "github_not_connected", code)
	c.Set("id", 42)
	for _, args := range []map[string]any{
		{"repo": "owner/project", "number": float64(0)},
		{"repo": "owner/project", "number": float64(2.5)},
		{"repo": "owner/project", "number": float64(2147483648)},
		{"repo": "owner/..", "number": float64(2)},
	} {
		result, code, _ = executeAgentDSHTool(c, "github_issue", args)
		assert.Nil(t, result)
		assert.Equal(t, "invalid_arguments", code)
	}
	assert.Equal(t, 2, requests, "invalid arguments or another unlinked account must not query GitHub")
}
