//go:build lain42composition

package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/dto"
	"github.com/QuantumNous/new-api/i18n"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/router"
	"github.com/QuantumNous/new-api/setting"
	"github.com/QuantumNous/new-api/setting/ratio_setting"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

// This dedicated Actions lane runs the built, supported dsh Web profile and
// actual New API auth, database, tool relay, provider adapter and wallet billing.
// Only external GitHub/model HTTP services are deterministic fixtures. It does
// not certify real-provider inference quality or production browser OAuth.
func TestBuiltDSHNewAPIReadAnswerAndReplay(t *testing.T) {
	root, err := filepath.Abs(os.Getenv("LAIN42_COMPOSITION_DSH_ROOT"))
	require.NoError(t, err)
	require.NotEmpty(t, os.Getenv("LAIN42_COMPOSITION_DSH_ROOT"), "this mandatory lane requires the built DSH checkout")
	_, err = os.Stat(filepath.Join(root, "apps/cli/lib/bin.js"))
	require.NoError(t, err, "build DSH in Actions before running composition acceptance")
	require.NoError(t, i18n.Init())
	const secret = "synthetic-full-composition-relay-secret"
	const issueURL = "https://github.com/owner/project/issues/2"
	const answer = "Persist an export request ID before retrying after a lost response. Source: " + issueURL
	const otherAnswer = "Hello from the second account."
	common.IsMasterNode = true
	common.SQLitePath = filepath.Join(t.TempDir(), "composition.db")
	t.Setenv("SQL_DSN", "local")
	t.Setenv("LOG_SQL_DSN", "")
	require.NoError(t, model.InitDB())
	db := model.DB
	model.LOG_DB = db
	sqlDB, err := db.DB()
	require.NoError(t, err)
	sqlDB.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = sqlDB.Close() })
	common.RedisEnabled, common.MemoryCacheEnabled, common.BatchUpdateEnabled = false, false, false
	common.LogConsumeEnabled, common.DataExportEnabled = true, false
	common.SessionCookieSecure = false
	common.CryptoSecret = "synthetic-composition-at-rest-secret"
	common.SetPerformanceMonitorConfig(common.PerformanceMonitorConfig{})
	setting.ModelRequestRateLimitEnabled, constant.CountToken = false, false
	constant.StreamingTimeout = 15
	gin.SetMode(gin.TestMode)
	require.NoError(t, ratio_setting.UpdateModelRatioByJSONString(`{"gpt-3.5-turbo":1}`))
	require.NoError(t, ratio_setting.UpdateCompletionRatioByJSONString(`{"gpt-3.5-turbo":2}`))
	require.NoError(t, ratio_setting.UpdateGroupRatioByJSONString(`{"default":1}`))
	require.NoError(t, db.AutoMigrate(&model.User{}, &model.Token{}, &model.Channel{}, &model.Ability{}, &model.Log{},
		&model.AgentDSHSession{}, &model.AgentDSHRequest{}, &model.AuthFlow{}, &model.AgentGitHubCredential{}))
	tokenA, tokenB := strings.Repeat("a", 32), strings.Repeat("b", 32)
	owner := model.User{Username: "composition-owner", Role: common.RoleCommonUser, Status: common.UserStatusEnabled,
		Group: "default", AuthVersion: 1, Quota: 100000, AffCode: "composition-owner-aff", Setting: `{"billing_preference":"wallet_only"}`}
	other := model.User{Username: "composition-other", Role: common.RoleCommonUser, Status: common.UserStatusEnabled,
		Group: "default", AuthVersion: 1, Quota: 100000, AffCode: "composition-other-aff", Setting: `{"billing_preference":"wallet_only"}`}
	owner.SetAccessToken(tokenA)
	other.SetAccessToken(tokenB)
	passwordHash, err := common.Password2Hash("synthetic-browser-password")
	require.NoError(t, err)
	owner.Password, other.Password = passwordHash, passwordHash
	require.NoError(t, db.Create(&owner).Error)
	require.NoError(t, db.Create(&other).Error)
	// Serve an initialized site, as production does before accepting logins.
	// Keep the real frontend setup guard; do not intercept its API response.
	require.NoError(t, db.Create(&model.User{Username: "fixture-root", Password: passwordHash,
		Role: common.RoleRootUser, Status: common.UserStatusEnabled, Group: "default",
		AuthVersion: 1, AffCode: "composition-root-aff"}).Error)
	model.CheckSetup()
	require.True(t, constant.Setup)
	require.NotNil(t, model.GetSetup())
	require.NoError(t, model.SaveAgentGitHubCredential(owner.Id, "provider-owner", "owner", "repo", "synthetic-owner-github-token"))

	var githubCalls, providerCalls atomic.Int32
	github := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		githubCalls.Add(1)
		if r.Method != http.MethodGet || r.Header.Get("Authorization") != "Bearer synthetic-owner-github-token" {
			http.Error(w, "wrong account GitHub authorization", http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/repos/owner/project/issues/2":
			_, _ = io.WriteString(w, `{"number":2,"state":"closed","title":"Export retry","body":"A reconnect delivers the same export twice.","comments":1,"html_url":"`+issueURL+`"}`)
		case "/repos/owner/project/issues/2/comments":
			_, _ = io.WriteString(w, `[{"body":"It still reproduces after a lost response.","user":{"login":"maintainer"}}]`)
		default:
			http.Error(w, "unexpected GitHub resource", http.StatusNotFound)
		}
	}))
	t.Cleanup(github.Close)
	originalTransport := http.DefaultTransport
	http.DefaultTransport = compositionGitHubTransport{delegate: originalTransport, origin: github.URL}
	t.Cleanup(func() { http.DefaultTransport = originalTransport })

	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		providerCalls.Add(1)
		body, readErr := io.ReadAll(r.Body)
		if readErr != nil || r.URL.Path != "/v1/chat/completions" || r.Header.Get("Authorization") != "Bearer synthetic-upstream-only-key" {
			http.Error(w, "invalid canonical provider request", http.StatusBadRequest)
			return
		}
		if strings.Contains(string(body), "synthetic-owner-github-token") || strings.Contains(string(body), secret) {
			http.Error(w, "account credentials leaked into inference", http.StatusBadRequest)
			return
		}
		var delta any
		finish := "stop"
		if strings.Contains(string(body), "Explain my attached browser note") {
			if !strings.Contains(string(body), "CLIENT_FILE_FACT_42") {
				http.Error(w, "client attachment did not reach inference", http.StatusBadRequest)
				return
			}
			delta = map[string]any{"role": "assistant", "content": "The attached note contains CLIENT_FILE_FACT_42.\n\n```rust\nfn main() { println!(\"CLIENT_FILE_FACT_42\"); }\n```"}
		} else if strings.Contains(string(body), "Say hello for the second account") {
			if strings.Contains(string(body), "lost response") || strings.Contains(string(body), issueURL) {
				http.Error(w, "another account's context leaked", http.StatusBadRequest)
				return
			}
			delta = map[string]any{"role": "assistant", "content": otherAnswer}
		} else if strings.Contains(string(body), `"role":"tool"`) {
			if !strings.Contains(string(body), "It still reproduces after a lost response.") || !strings.Contains(string(body), issueURL) || !strings.Contains(string(body), "closed") {
				http.Error(w, "Issue evidence did not reach continuation", http.StatusBadRequest)
				return
			}
			delta = map[string]any{"role": "assistant", "content": answer}
		} else {
			if !strings.Contains(string(body), "lain42_github_issue") || !strings.Contains(string(body), issueURL) {
				http.Error(w, "the current request or Issue tool is missing", http.StatusBadRequest)
				return
			}
			finish = "tool_calls"
			delta = map[string]any{"role": "assistant", "tool_calls": []any{map[string]any{
				"index": 0, "id": "read-issue-2", "type": "function", "function": map[string]any{
					"name": "lain42_github_issue", "arguments": `{"repo":"owner/project","number":2}`}}}}
		}
		w.Header().Set("Content-Type", "text/event-stream")
		for _, chunk := range []any{
			map[string]any{"id": "chatcmpl-composition", "object": "chat.completion.chunk", "created": 1, "model": "gpt-3.5-turbo", "choices": []any{map[string]any{"index": 0, "delta": delta, "finish_reason": nil}}},
			map[string]any{"id": "chatcmpl-composition", "object": "chat.completion.chunk", "created": 1, "model": "gpt-3.5-turbo", "choices": []any{map[string]any{"index": 0, "delta": map[string]any{}, "finish_reason": finish}}},
			map[string]any{"id": "chatcmpl-composition", "object": "chat.completion.chunk", "created": 1, "model": "gpt-3.5-turbo", "choices": []any{}, "usage": map[string]int{"prompt_tokens": 20, "completion_tokens": 10, "total_tokens": 30}},
		} {
			bytes, _ := json.Marshal(chunk)
			_, _ = fmt.Fprintf(w, "data: %s\n\n", bytes)
		}
		_, _ = io.WriteString(w, "data: [DONE]\n\n")
	}))
	t.Cleanup(provider.Close)
	baseURL := provider.URL
	channel := model.Channel{Type: constant.ChannelTypeOpenAI, Key: "synthetic-upstream-only-key", Status: common.ChannelStatusEnabled,
		Name: "composition-provider", Group: "default", Models: "gpt-3.5-turbo", BaseURL: &baseURL}
	require.NoError(t, channel.Insert())
	t.Setenv("LAIN42_DSH_BRIDGE_SECRET", secret)
	t.Setenv("LAIN42_AGENT_MODEL_RELAY_SECRET", secret)
	engine := gin.New()
	router.SetRouter(engine, router.WebAssets{BuildFS: buildFS, IndexPage: indexPage})
	controlPlane := httptest.NewServer(engine)
	t.Cleanup(controlPlane.Close)
	work := t.TempDir()
	patch := filepath.Join(work, "composition.patch.yml")
	configuration := []any{
		map[string]any{"id": "web-runtime", "config": map[string]any{"openBrowser": false, "printUrl": true, "enableLain42Bridge": true}},
		map[string]any{"id": "session-title-llm", "disabled": true},
		map[string]any{"id": "agent-default-model", "config": map[string]any{"provider": "lain42-web", "model": "gpt-3.5-turbo"}},
		map[string]any{"id": "llm-pi-ai", "config": map[string]any{"providers": map[string]any{"lain42-web": map[string]any{
			"api": "openai-completions", "baseURL": controlPlane.URL + "/v1/agent", "apiKeyEnv": "LAIN42_COMPOSITION_KEY", "models": []any{map[string]any{"id": "gpt-3.5-turbo"}}}}}},
	}
	encoded, err := json.Marshal(configuration)
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(patch, encoded, 0600))
	stop, origin := startCompositionDSH(t, root, work, patch, controlPlane.URL, secret)
	t.Setenv("LAIN42_DSH_BASE_URL", origin)
	post := func(token, path string, body any) (int, string) {
		bytes, marshalErr := json.Marshal(body)
		require.NoError(t, marshalErr)
		request, requestErr := http.NewRequest(http.MethodPost, controlPlane.URL+path, strings.NewReader(string(bytes)))
		require.NoError(t, requestErr)
		request.Header.Set("Authorization", "Bearer "+token)
		request.Header.Set("Content-Type", "application/json")
		response, requestErr := (&http.Client{Timeout: 140 * time.Second}).Do(request)
		require.NoError(t, requestErr)
		defer response.Body.Close()
		result, readErr := io.ReadAll(response.Body)
		require.NoError(t, readErr)
		return response.StatusCode, string(result)
	}
	create := func(token string) string {
		status, body := post(token, "/api/agent/dsh/sessions", nil)
		require.Equal(t, http.StatusOK, status, body)
		var envelope struct {
			Success bool
			Data    struct {
				SessionID string `json:"session_id"`
			}
		}
		require.NoError(t, json.Unmarshal([]byte(body), &envelope))
		require.True(t, envelope.Success)
		require.Len(t, envelope.Data.SessionID, 64)
		return envelope.Data.SessionID
	}
	sessionA, sessionB := create(tokenA), create(tokenB)
	turnA := dto.AgentDSHTurnRequest{SessionID: sessionA, RequestID: "44444444-4444-4444-8444-444444444444", Model: "gpt-3.5-turbo", Text: "Read " + issueURL + " and propose a fix based on its discussion."}
	turnB := dto.AgentDSHTurnRequest{SessionID: sessionB, RequestID: turnA.RequestID, Model: turnA.Model, Text: "Say hello for the second account"}
	status, body := post(tokenB, "/api/agent/dsh/turns", turnA)
	require.Equal(t, http.StatusNotFound, status, body)
	require.Zero(t, providerCalls.Load(), "foreign sessions must not reach DSH or inference")
	for _, turn := range []struct {
		token   string
		request dto.AgentDSHTurnRequest
		answer  string
	}{{tokenA, turnA, answer}, {tokenB, turnB, otherAnswer}} {
		status, body = post(turn.token, "/api/agent/dsh/turns", turn.request)
		require.Equal(t, http.StatusOK, status, body)
		require.Contains(t, body, turn.answer)
		require.NotContains(t, body, "synthetic-owner-github-token")
	}
	require.EqualValues(t, 3, providerCalls.Load(), "Issue read needs one tool step and one model continuation; B has one step")
	require.EqualValues(t, 2, githubCalls.Load(), "selected Issue and its discussion, with owner OAuth")
	stop()
	_, origin = startCompositionDSH(t, root, work, patch, controlPlane.URL, secret)
	t.Setenv("LAIN42_DSH_BASE_URL", origin)
	for _, turn := range []struct {
		token   string
		request dto.AgentDSHTurnRequest
		answer  string
	}{{tokenA, turnA, answer}, {tokenB, turnB, otherAnswer}} {
		status, body = post(turn.token, "/api/agent/dsh/turns", turn.request)
		require.Equal(t, http.StatusOK, status, body)
		require.Contains(t, body, turn.answer)
	}
	require.EqualValues(t, 3, providerCalls.Load(), "durable replay after DSH restart must not re-infer or double-charge")
	require.EqualValues(t, 2, githubCalls.Load(), "durable replay must not reread GitHub")
	for _, account := range []struct {
		user  model.User
		calls int
	}{{owner, 2}, {other, 1}} {
		var updated model.User
		require.NoError(t, db.First(&updated, account.user.Id).Error)
		var logs []model.Log
		require.NoError(t, db.Where("user_id = ? AND type = ?", account.user.Id, model.LogTypeConsume).Find(&logs).Error)
		require.Len(t, logs, account.calls)
		for _, entry := range logs {
			require.Equal(t, 40, entry.Quota)
			require.Zero(t, entry.TokenId)
		}
		require.Equal(t, account.user.Quota-account.calls*40, updated.Quota)
		require.Equal(t, account.calls*40, updated.UsedQuota)
	}
	var tokenCount int64
	require.NoError(t, db.Model(&model.Token{}).Count(&tokenCount).Error)
	require.Zero(t, tokenCount)
	// Run the production build, not a DOM fixture or a route-intercepted UI.
	// Password login, refresh cookie, Agent turns and attachment conversion use
	// the real browser and server. The provider remains the declared fixture.
	browserScript, err := filepath.Abs("scripts/lain42-browser-acceptance.mjs")
	require.NoError(t, err)
	browserContext, cancelBrowser := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancelBrowser()
	browser := exec.CommandContext(browserContext, "node", browserScript, controlPlane.URL)
	browser.Env = os.Environ()
	browser.Stdout, browser.Stderr = os.Stdout, os.Stderr
	require.NoError(t, browser.Run())
	require.EqualValues(t, 5, providerCalls.Load(), "each viewport sends one real attachment turn")
	require.EqualValues(t, 2, githubCalls.Load(), "attachment chat has no unrelated GitHub request")
	for _, account := range []struct {
		user  model.User
		calls int
	}{{owner, 3}, {other, 2}} {
		var updated model.User
		require.NoError(t, db.First(&updated, account.user.Id).Error)
		require.Equal(t, account.user.Quota-account.calls*40, updated.Quota,
			"browser attachment and refresh must charge only the owning account, once")
		var logs []model.Log
		require.NoError(t, db.Where("user_id = ? AND type = ?", account.user.Id, model.LogTypeConsume).Find(&logs).Error)
		require.Len(t, logs, account.calls)
		for _, entry := range logs {
			require.Equal(t, 40, entry.Quota)
			require.Zero(t, entry.TokenId)
		}
	}
}

type compositionGitHubTransport struct {
	delegate http.RoundTripper
	origin   string
}

func (fixture compositionGitHubTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	if request.URL.Hostname() != "api.github.com" {
		return fixture.delegate.RoundTrip(request)
	}
	clone := request.Clone(request.Context())
	copyURL := *request.URL
	clone.URL = &copyURL
	clone.URL.Scheme = "http"
	clone.URL.Host = strings.TrimPrefix(fixture.origin, "http://")
	return fixture.delegate.RoundTrip(clone)
}

// Start only the repository's supported built dsh profile, with a private home.
func startCompositionDSH(t *testing.T, root, work, patch, controlPlane, secret string) (func(), string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	command := exec.CommandContext(ctx, "node", "--no-experimental-strip-types", filepath.Join(root, "apps/cli/lib/bin.js"),
		"--profile", "web", "--patch", patch, "--host", "127.0.0.1", "--port", "0", "--no-open")
	command.Dir = work
	command.Env = append(os.Environ(), "DSH_HOME="+filepath.Join(work, "home"), "DSH_AGENTS_HOME="+filepath.Join(work, ".agents"),
		"DSH_TELEMETRY_DISABLED=1", "NODE_NO_WARNINGS=1", "LAIN42_COMPOSITION_KEY=synthetic-model-only-key",
		"LAIN42_DSH_BRIDGE_SECRET="+secret, "LAIN42_AGENT_MODEL_RELAY_SECRET="+secret,
		"LAIN42_AGENT_TOOL_RELAY_URL="+controlPlane+"/api/agent/bridge/v1/tool",
		"HTTP_PROXY=", "HTTPS_PROXY=", "ALL_PROXY=", "NODE_OPTIONS=", "NODE_PATH=", "TSX_TSCONFIG_PATH=")
	stdout, err := command.StdoutPipe()
	require.NoError(t, err)
	command.Stderr = os.Stderr
	require.NoError(t, command.Start())
	done := make(chan error, 1)
	ready := make(chan string, 1)
	go func() {
		scanner := bufio.NewScanner(stdout)
		pattern := regexp.MustCompile(`dsh web: (http://[^\s]+)`)
		for scanner.Scan() {
			line := scanner.Text()
			if match := pattern.FindStringSubmatch(line); len(match) == 2 {
				select {
				case ready <- match[1]:
				default:
				}
			}
		}
	}()
	go func() { done <- command.Wait() }()
	stopped := false
	stop := func() {
		if stopped {
			return
		}
		stopped = true
		cancel()
		select {
		case <-done:
		case <-time.After(10 * time.Second):
			t.Error("DSH process did not stop")
		}
	}
	t.Cleanup(stop)
	select {
	case origin := <-ready:
		// The printed browser URL may contain its local Web authentication token.
		// The server-to-server HMAC endpoint accepts only an origin, not that URL.
		parsed, err := url.Parse(origin)
		require.NoError(t, err)
		require.Equal(t, "127.0.0.1", parsed.Hostname())
		return stop, parsed.Scheme + "://" + parsed.Host
	case err := <-done:
		stopped = true
		cancel()
		t.Fatalf("built DSH exited before readiness: %v", err)
	case <-time.After(60 * time.Second):
		t.Fatal("built DSH did not advertise its Web origin")
	}
	return stop, ""
}
