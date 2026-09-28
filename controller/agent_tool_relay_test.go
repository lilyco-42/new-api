package controller

import (
	"archive/zip"
	"bytes"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

const agentToolRelayTestSecret = "test-lain42-dsh-bridge-secret-long-enough"

type agentToolRelayRoundTripper func(*http.Request) (*http.Response, error)

func (roundTrip agentToolRelayRoundTripper) RoundTrip(request *http.Request) (*http.Response, error) {
	return roundTrip(request)
}

func setupAgentToolRelayTest(t *testing.T) {
	t.Helper()
	previousDB := model.DB
	previousCryptoSecret := common.CryptoSecret
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	sqlDB, err := db.DB()
	require.NoError(t, err)
	sqlDB.SetMaxOpenConns(1)
	model.DB = db
	common.CryptoSecret = "agent-tool-relay-test-crypto-secret"
	require.NoError(t, model.DB.AutoMigrate(&model.AgentWebSession{}, &model.AgentModelRelayNonce{}, &model.AgentGitHubCredential{}))
	t.Setenv(service.AgentDSHBridgeSecretEnv, agentToolRelayTestSecret)
	previousMode := gin.Mode()
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() {
		model.DB = previousDB
		common.CryptoSecret = previousCryptoSecret
		gin.SetMode(previousMode)
		_ = sqlDB.Close()
	})
}

func TestAgentDSHToolRelayUsesOAuthCredentialBoundToStoredSessionOwner(t *testing.T) {
	setupAgentToolRelayTest(t)
	userSeven, err := model.CreateAgentWebSession(7)
	require.NoError(t, err)
	_, err = model.CreateAgentWebSession(8)
	require.NoError(t, err)
	require.NoError(t, model.SaveAgentGitHubCredential(7, "gh-user-7", "user-seven", "repo", "token-seven"))
	require.NoError(t, model.SaveAgentGitHubCredential(8, "gh-user-8", "user-eight", "repo", "token-eight"))

	previousTransport := http.DefaultTransport
	var authorization string
	http.DefaultTransport = agentToolRelayRoundTripper(func(request *http.Request) (*http.Response, error) {
		authorization = request.Header.Get("Authorization")
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     make(http.Header),
			Body:       io.NopCloser(strings.NewReader(`[{"full_name":"user-seven/private-repo","html_url":"https://github.com/user-seven/private-repo","stargazers_count":2,"private":true}]`)),
		}, nil
	})
	t.Cleanup(func() { http.DefaultTransport = previousTransport })

	recorder := invokeAgentToolRelay(t, map[string]any{
		"version": 1, "session_id": userSeven.DshSessionId, "tool": "github_repositories", "arguments": map[string]any{"limit": 3},
	})
	require.Equal(t, http.StatusOK, recorder.Code)
	assert.Equal(t, "Bearer token-seven", authorization)
	assert.Contains(t, recorder.Body.String(), "user-seven/private-repo")
	assert.NotContains(t, recorder.Body.String(), "token-seven")
	assert.NotContains(t, recorder.Body.String(), "token-eight")
}

func TestAgentDSHToolRelayRejectsReplayAndUntrustedIdentityFields(t *testing.T) {
	setupAgentToolRelayTest(t)
	session, err := model.CreateAgentWebSession(7)
	require.NoError(t, err)
	request := map[string]any{
		"version": 1, "session_id": session.DshSessionId, "tool": "unknown_tool", "arguments": map[string]any{},
	}
	body, err := common.Marshal(request)
	require.NoError(t, err)
	nonce := randomAgentToolRelayNonce(t)
	recorder := invokeSignedAgentToolRelay(t, body, nonce)
	require.Equal(t, http.StatusOK, recorder.Code)

	replay := invokeSignedAgentToolRelay(t, body, nonce)
	assert.Equal(t, http.StatusUnauthorized, replay.Code)

	request["user_id"] = 8
	forgedBody, err := common.Marshal(request)
	require.NoError(t, err)
	forged := invokeSignedAgentToolRelay(t, forgedBody, randomAgentToolRelayNonce(t))
	assert.Equal(t, http.StatusBadRequest, forged.Code)
}

func TestAgentDSHToolRelayReportsOAuthRequirementAndBlocksPrivateFetchTargets(t *testing.T) {
	setupAgentToolRelayTest(t)
	session, err := model.CreateAgentWebSession(7)
	require.NoError(t, err)
	github := invokeAgentToolRelay(t, map[string]any{
		"version": 1, "session_id": session.DshSessionId, "tool": "github_repositories", "arguments": map[string]any{},
	})
	require.Equal(t, http.StatusOK, github.Code)
	assert.Contains(t, github.Body.String(), "github_not_connected")
	assert.Contains(t, github.Body.String(), "Connect GitHub in this website account")

	fetch := invokeAgentToolRelay(t, map[string]any{
		"version": 1, "session_id": session.DshSessionId, "tool": "web_fetch", "arguments": map[string]any{"url": "http://127.0.0.1/secret"},
	})
	require.Equal(t, http.StatusOK, fetch.Code)
	assert.Contains(t, fetch.Body.String(), "url_not_allowed")
}

func TestAgentDSHToolRelayRejectsRepositoryPathTraversal(t *testing.T) {
	setupAgentToolRelayTest(t)
	session, err := model.CreateAgentWebSession(7)
	require.NoError(t, err)
	require.NoError(t, model.SaveAgentGitHubCredential(7, "gh-user-7", "user-seven", "repo", "token-seven"))

	recorder := invokeAgentToolRelay(t, map[string]any{
		"version":    1,
		"session_id": session.DshSessionId,
		"tool":       "github_issues",
		"arguments":  map[string]any{"repo": "owner/../private", "limit": 1},
	})

	require.Equal(t, http.StatusOK, recorder.Code)
	assert.Contains(t, recorder.Body.String(), "invalid_arguments")
	assert.Contains(t, recorder.Body.String(), "owner/name")
}

func TestAgentDSHToolRelayReadsGitHubActionsRunsAndJobs(t *testing.T) {
	setupAgentToolRelayTest(t)
	session, err := model.CreateAgentWebSession(7)
	require.NoError(t, err)
	require.NoError(t, model.SaveAgentGitHubCredential(7, "gh-user-7", "user-seven", "repo", "token-seven"))
	previousTransport := http.DefaultTransport
	var endpoints []string
	http.DefaultTransport = agentToolRelayRoundTripper(func(request *http.Request) (*http.Response, error) {
		endpoints = append(endpoints, request.URL.String())
		assert.Equal(t, "Bearer token-seven", request.Header.Get("Authorization"))
		body := `{"workflow_runs":[{"id":123,"name":"CI","event":"push","status":"completed","conclusion":"failure","head_branch":"main","head_sha":"abc123","run_number":8,"html_url":"https://github.com/owner/repo/actions/runs/123","created_at":"2026-09-28T10:00:00Z"}]}`
		if strings.Contains(request.URL.Path, "/jobs") {
			body = `{"total_count":1,"jobs":[{"id":456,"name":"test","status":"completed","conclusion":"failure","html_url":"https://github.com/owner/repo/actions/runs/123/job/456","steps":[{"name":"go test","status":"completed","conclusion":"failure","number":4}]}]}`
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": []string{"application/json"}},
			Body:       io.NopCloser(strings.NewReader(body)),
		}, nil
	})
	t.Cleanup(func() { http.DefaultTransport = previousTransport })

	runs := invokeAgentToolRelay(t, map[string]any{
		"version": 1, "session_id": session.DshSessionId, "tool": "github_actions_runs",
		"arguments": map[string]any{"repo": "owner/repo", "status": "completed", "limit": 5},
	})
	require.Equal(t, http.StatusOK, runs.Code)
	assert.Contains(t, runs.Body.String(), `"conclusion":"failure"`)
	assert.Contains(t, endpoints[0], "status=completed")

	jobs := invokeAgentToolRelay(t, map[string]any{
		"version": 1, "session_id": session.DshSessionId, "tool": "github_actions_jobs",
		"arguments": map[string]any{"repo": "owner/repo", "run_id": 123, "limit": 10},
	})
	require.Equal(t, http.StatusOK, jobs.Code)
	assert.Contains(t, jobs.Body.String(), `"name":"go test"`)
	assert.Contains(t, endpoints[1], "/actions/runs/123/jobs")

	invalid := invokeAgentToolRelay(t, map[string]any{
		"version": 1, "session_id": session.DshSessionId, "tool": "github_actions_jobs",
		"arguments": map[string]any{"repo": "owner/repo", "run_id": "123"},
	})
	require.Equal(t, http.StatusOK, invalid.Code)
	assert.Contains(t, invalid.Body.String(), "invalid_arguments")
}

func TestAgentDSHToolRelayFindsRecentActionsAcrossAccessibleRepositories(t *testing.T) {
	setupAgentToolRelayTest(t)
	session, err := model.CreateAgentWebSession(7)
	require.NoError(t, err)
	require.NoError(t, model.SaveAgentGitHubCredential(7, "gh-user-7", "user-seven", "repo", "token-seven"))
	previousTransport := http.DefaultTransport
	var seenMu sync.Mutex
	seenRepositories := map[string]bool{}
	http.DefaultTransport = agentToolRelayRoundTripper(func(request *http.Request) (*http.Response, error) {
		assert.Equal(t, "Bearer token-seven", request.Header.Get("Authorization"))
		var body string
		switch {
		case request.URL.Path == "/user/repos":
			body = `[{"full_name":"owner/repo-one"},{"full_name":"owner/repo-two"}]`
		case strings.HasSuffix(request.URL.Path, "/actions/runs"):
			repo := strings.TrimSuffix(strings.TrimPrefix(request.URL.Path, "/repos/"), "/actions/runs")
			seenMu.Lock()
			seenRepositories[repo] = true
			seenMu.Unlock()
			id := 301
			if repo == "owner/repo-two" {
				id = 302
			}
			body = fmt.Sprintf(`{"workflow_runs":[{"id":%d,"name":"CI","status":"completed","conclusion":"success","head_branch":"main","head_sha":"abc123","run_number":1,"html_url":"https://github.com/%s/actions/runs/%d","updated_at":"2026-09-28T10:00:00Z"}]}`, id, repo, id)
		default:
			return nil, fmt.Errorf("unexpected GitHub Actions endpoint: %s", request.URL.Path)
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": []string{"application/json"}},
			Body:       io.NopCloser(strings.NewReader(body)),
		}, nil
	})
	t.Cleanup(func() { http.DefaultTransport = previousTransport })

	response := invokeAgentToolRelay(t, map[string]any{
		"version": 1, "session_id": session.DshSessionId, "tool": "github_actions_runs",
		"arguments": map[string]any{"limit": 5},
	})
	require.Equal(t, http.StatusOK, response.Code)
	assert.Contains(t, response.Body.String(), `"repository_full_name":"owner/repo-one"`)
	assert.Contains(t, response.Body.String(), `"repository_full_name":"owner/repo-two"`)
	assert.True(t, seenRepositories["owner/repo-one"])
	assert.True(t, seenRepositories["owner/repo-two"])
}

func TestAgentGitHubActionsRunsHandlerUsesSignedInBrowserOAuth(t *testing.T) {
	setupAgentToolRelayTest(t)
	require.NoError(t, model.SaveAgentGitHubCredential(7, "gh-user-7", "user-seven", "repo", "token-seven"))
	previousTransport := http.DefaultTransport
	http.DefaultTransport = agentToolRelayRoundTripper(func(request *http.Request) (*http.Response, error) {
		assert.Equal(t, "Bearer token-seven", request.Header.Get("Authorization"))
		var body string
		switch request.URL.Path {
		case "/user/repos":
			body = `[{"full_name":"owner/repo"}]`
		case "/repos/owner/repo/actions/runs":
			body = `{"workflow_runs":[{"id":401,"name":"CI","status":"completed","conclusion":"success","html_url":"https://github.com/owner/repo/actions/runs/401"}]}`
		default:
			return nil, fmt.Errorf("unexpected GitHub Actions endpoint: %s", request.URL.Path)
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": []string{"application/json"}},
			Body:       io.NopCloser(strings.NewReader(body)),
		}, nil
	})
	t.Cleanup(func() { http.DefaultTransport = previousTransport })

	router := gin.New()
	router.GET("/api/agent/github/actions/runs", func(c *gin.Context) {
		c.Set("id", 7)
		AgentGitHubActionsRuns(c)
	})
	request := httptest.NewRequest(http.MethodGet, "/api/agent/github/actions/runs?limit=3", nil)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)

	require.Equal(t, http.StatusOK, recorder.Code)
	assert.Contains(t, recorder.Body.String(), `"repository_full_name":"owner/repo"`)
	assert.Contains(t, recorder.Body.String(), `"id":401`)
}

func TestAgentDSHToolRelayReadsBoundedRedactedGitHubActionLogs(t *testing.T) {
	setupAgentToolRelayTest(t)
	session, err := model.CreateAgentWebSession(7)
	require.NoError(t, err)
	require.NoError(t, model.SaveAgentGitHubCredential(7, "gh-user-7", "user-seven", "repo", "token-seven"))
	var archive bytes.Buffer
	zipWriter := zip.NewWriter(&archive)
	logFile, err := zipWriter.Create("0_test_job.txt")
	require.NoError(t, err)
	_, err = logFile.Write([]byte("Build failed in go test.\nAuthorization: Bearer raw-secret-value\nGITHUB_TOKEN=ghp_123456789012345678901234567890\n"))
	require.NoError(t, err)
	require.NoError(t, zipWriter.Close())

	previousTransport := http.DefaultTransport
	var archiveRequestSeen bool
	archiveURL := "https://actionslogs.blob.core.windows.net/logs/job.zip?sig=temporary-secret"
	http.DefaultTransport = agentToolRelayRoundTripper(func(request *http.Request) (*http.Response, error) {
		if request.URL.Host == "api.github.com" {
			assert.Equal(t, "Bearer token-seven", request.Header.Get("Authorization"))
			return &http.Response{
				StatusCode: http.StatusFound,
				Header:     http.Header{"Location": []string{archiveURL}},
				Body:       io.NopCloser(strings.NewReader("")),
			}, nil
		}
		archiveRequestSeen = true
		assert.Empty(t, request.Header.Get("Authorization"))
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": []string{"application/zip"}},
			Body:       io.NopCloser(bytes.NewReader(archive.Bytes())),
		}, nil
	})
	t.Cleanup(func() { http.DefaultTransport = previousTransport })

	response := invokeAgentToolRelay(t, map[string]any{
		"version": 1, "session_id": session.DshSessionId, "tool": "github_actions_logs",
		"arguments": map[string]any{"repo": "owner/repo", "job_id": 456},
	})
	require.Equal(t, http.StatusOK, response.Code)
	assert.True(t, archiveRequestSeen)
	assert.Contains(t, response.Body.String(), "Build failed in go test")
	assert.Contains(t, response.Body.String(), "untrusted data")
	assert.NotContains(t, response.Body.String(), "raw-secret-value")
	assert.NotContains(t, response.Body.String(), "ghp_123456789012345678901234567890")
	assert.NotContains(t, response.Body.String(), "temporary-secret")

	archiveRequestSeen = false
	archiveURL = "http://127.0.0.1/private"
	blocked := invokeAgentToolRelay(t, map[string]any{
		"version": 1, "session_id": session.DshSessionId, "tool": "github_actions_logs",
		"arguments": map[string]any{"repo": "owner/repo", "job_id": 456},
	})
	require.Equal(t, http.StatusOK, blocked.Code)
	assert.Contains(t, blocked.Body.String(), "github_request_failed")
	assert.False(t, archiveRequestSeen)
}

func invokeAgentToolRelay(t *testing.T, body any) *httptest.ResponseRecorder {
	t.Helper()
	bytes, err := common.Marshal(body)
	require.NoError(t, err)
	return invokeSignedAgentToolRelay(t, bytes, randomAgentToolRelayNonce(t))
}

func invokeSignedAgentToolRelay(t *testing.T, body []byte, nonce string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, service.AgentDSHToolRelayPath, bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	timestamp := fmt.Sprint(time.Now().UTC().Unix())
	request.Header.Set("X-Lain42-Timestamp", timestamp)
	request.Header.Set("X-Lain42-Nonce", nonce)
	request.Header.Set("X-Lain42-Signature", signAgentToolRelayTestRequest(agentToolRelayTestSecret, timestamp, nonce, body))
	recorder := httptest.NewRecorder()
	context, _ := gin.CreateTestContext(recorder)
	context.Request = request
	AgentDSHToolRelay(context)
	return recorder
}

func signAgentToolRelayTestRequest(secret, timestamp, nonce string, body []byte) string {
	digest := sha256.Sum256(body)
	canonical := fmt.Sprintf("v1\n%s\n%s\nPOST\n%s\n%s", timestamp, nonce, service.AgentDSHToolRelayPath, hex.EncodeToString(digest[:]))
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(canonical))
	return hex.EncodeToString(mac.Sum(nil))
}

func randomAgentToolRelayNonce(t *testing.T) string {
	t.Helper()
	entropy := make([]byte, 16)
	_, err := rand.Read(entropy)
	require.NoError(t, err)
	return hex.EncodeToString(entropy)
}
