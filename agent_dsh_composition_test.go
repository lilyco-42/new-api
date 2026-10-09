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
	"sync"
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
	const recoveryPrompt = "Keep working if the browser loses this response."
	const recoveryAnswer = "The original task completed after its observer disconnected."
	const accountIssuesPrompt = "Read the recent open issues in my GitHub repositories and propose a fix."
	const accountIssueURL = "https://github.com/owner/project/issues/17"
	const accountIssueAnswer = "Issue #17 loses completed item IDs on refresh. Persist the manifest after each completed item and restore it before retrying. Source: " + accountIssueURL + ". No comment or repository change was published."
	const unlinkedIssueAnswer = "No issue content was read for this account. Connect GitHub on this website; local gh login and a paired device are not required."
	const accountIssueFollowUp = "What should I persist for the issue you just read?"
	const accountIssueFollowUpAnswer = "Persist the completed item IDs in the batch manifest from Issue #17. Source: " + accountIssueURL
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

	var githubCalls, providerCalls, accountIssueSearchCalls, browserIssueInferenceCalls atomic.Int32
	recoveryStarted := make(chan struct{}, 1)
	recoveryReleased := make(chan struct{})
	var releaseRecoveryOnce sync.Once
	releaseRecovery := func() { releaseRecoveryOnce.Do(func() { close(recoveryReleased) }) }
	defer releaseRecovery()
	// Synchronize real browser navigation with the external model fixture.
	// These controls never replace website auth, turn responses or billing.
	type browserRecoveryGate struct {
		started, released, canceled        chan struct{}
		startOnce, releaseOnce, cancelOnce sync.Once
	}
	browserRecovery := map[string]*browserRecoveryGate{}
	for _, viewport := range []string{"desktop", "mobile", "desktop-stop", "mobile-stop"} {
		gate := &browserRecoveryGate{started: make(chan struct{}), released: make(chan struct{}), canceled: make(chan struct{})}
		browserRecovery[viewport] = gate
		defer gate.releaseOnce.Do(func() { close(gate.released) })
	}
	github := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		githubCalls.Add(1)
		if r.Method != http.MethodGet || r.Header.Get("Authorization") != "Bearer synthetic-owner-github-token" {
			http.Error(w, "wrong account GitHub authorization", http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/search/issues":
			if r.URL.Query().Get("q") != "user:owner is:issue is:open" || r.URL.Query().Get("sort") != "updated" || r.URL.Query().Get("order") != "desc" || r.URL.Query().Get("per_page") != "10" {
				http.Error(w, "issue search did not use the connected account and bounded scope", http.StatusBadRequest)
				return
			}
			accountIssueSearchCalls.Add(1)
			_, _ = io.WriteString(w, `{"total_count":1,"incomplete_results":false,"items":[{"number":17,"state":"open","title":"Browser batch recovery","body":"BROWSER_ISSUE_FACT_17: refresh loses completed item IDs.","repository_url":"https://api.github.com/repos/owner/project","html_url":"https://github.com/owner/project/issues/17"}]}`)
		case "/repos/owner/project/issues/2":
			_, _ = io.WriteString(w, `{"number":2,"state":"closed","title":"Export retry","body":"A reconnect delivers the same export twice.","comments":1,"html_url":"`+issueURL+`"}`)
		case "/repos/owner/project/issues/2/comments":
			_, _ = io.WriteString(w, `[{"body":"It still reproduces after a lost response.","user":{"login":"maintainer"}}]`)
		case "/repos/owner/project/issues/17":
			_, _ = io.WriteString(w, `{"number":17,"state":"open","title":"Browser batch recovery","body":"DETAIL_ISSUE_FACT_17: only completed item IDs belong in the durable batch manifest.","comments":1,"html_url":"`+accountIssueURL+`"}`)
		case "/repos/owner/project/issues/17/comments":
			_, _ = io.WriteString(w, `[{"body":"DISCUSSION_ISSUE_FACT_17: restore the saved manifest before retrying.","user":{"login":"maintainer"}}]`)
		default:
			http.Error(w, "unexpected GitHub resource", http.StatusNotFound)
		}
	}))
	t.Cleanup(github.Close)
	originalTransport := http.DefaultTransport
	http.DefaultTransport = compositionGitHubTransport{delegate: originalTransport, origin: github.URL}
	t.Cleanup(func() { http.DefaultTransport = originalTransport })

	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/fixture/browser/") {
			parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/fixture/browser/"), "/")
			if len(parts) != 2 || browserRecovery[parts[0]] == nil {
				http.Error(w, "unknown browser fixture control", http.StatusNotFound)
				return
			}
			gate := browserRecovery[parts[0]]
			switch parts[1] {
			case "started":
				select {
				case <-gate.started:
				case <-r.Context().Done():
					return
				}
			case "release":
				gate.releaseOnce.Do(func() { close(gate.released) })
			case "canceled":
				select {
				case <-gate.canceled:
				case <-r.Context().Done():
					return
				}
			default:
				http.Error(w, "unknown browser fixture action", http.StatusNotFound)
				return
			}
			w.WriteHeader(http.StatusNoContent)
			return
		}
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
		var inference struct {
			Messages []struct {
				Role    string          `json:"role"`
				Content json.RawMessage `json:"content"`
			} `json:"messages"`
			Tools []json.RawMessage `json:"tools"`
		}
		if json.Unmarshal(body, &inference) != nil {
			http.Error(w, "invalid model messages", http.StatusBadRequest)
			return
		}
		var latestUser string
		var scopedImageRead bool
		for _, message := range inference.Messages {
			if message.Role == "user" {
				if json.Unmarshal(message.Content, &latestUser) != nil {
					var parts []struct {
						Type     string `json:"type"`
						Text     string `json:"text"`
						ImageURL struct {
							URL string `json:"url"`
						} `json:"image_url"`
					}
					if json.Unmarshal(message.Content, &parts) != nil {
						http.Error(w, "invalid multimodal instruction", http.StatusBadRequest)
						return
					}
					latestUser = ""
					for _, part := range parts {
						if part.Type == "text" {
							latestUser += part.Text
						}
						if part.Type == "image_url" && part.ImageURL.URL == "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC" {
							scopedImageRead = true
						}
					}
				}
			}
		}
		// A new session can contain seeded history. Match the explicit current
		// instruction, not an earlier user request quoted in that history.
		const currentInstruction = "Current user request:\n"
		currentTurnEvidence := latestUser
		if index := strings.LastIndex(latestUser, currentInstruction); index >= 0 {
			latestUser = latestUser[index+len(currentInstruction):]
		}
		var delta any
		finish := "stop"
		var browserGate *browserRecoveryGate
		var browserViewport string
		for viewport, gate := range browserRecovery {
			if strings.Contains(latestUser, "Recover this browser task for "+viewport+".") ||
				(strings.HasSuffix(viewport, "-stop") && strings.Contains(latestUser, "Stop this browser task for "+strings.TrimSuffix(viewport, "-stop")+".")) {
				browserGate, browserViewport = gate, viewport
				break
			}
		}
		if strings.Contains(latestUser, accountIssueFollowUp) {
			if len(inference.Tools) != 0 || !strings.Contains(string(body), accountIssueAnswer) {
				http.Error(w, "issue follow-up lost its answer or widened account permissions", http.StatusBadRequest)
				return
			}
			delta = map[string]any{"role": "assistant", "content": accountIssueFollowUpAnswer}
		} else if strings.Contains(latestUser, accountIssuesPrompt) {
			var toolResults []string
			for _, message := range inference.Messages {
				if message.Role == "tool" {
					var result string
					if common.Unmarshal(message.Content, &result) != nil {
						http.Error(w, "account Issue tool result was not textual evidence", http.StatusBadRequest)
						return
					}
					toolResults = append(toolResults, result)
				}
			}
			toolName, toolID, arguments := "lain42_github_issues_search", "search-account-issues", `{}`
			switch len(toolResults) {
			case 0:
				if !strings.Contains(string(body), toolName) || !strings.Contains(string(body), "lain42_github_issue") {
					http.Error(w, "account search and detail capabilities were not offered", http.StatusBadRequest)
					return
				}
			case 1:
				if strings.Contains(toolResults[0], "github_not_connected") {
					if strings.Contains(string(body), "BROWSER_ISSUE_FACT_17") || strings.Contains(string(body), "DETAIL_ISSUE_FACT_17") || strings.Contains(string(body), accountIssueAnswer) {
						http.Error(w, "unlinked account inherited another account's Issue evidence", http.StatusBadRequest)
						return
					}
					delta = map[string]any{"role": "assistant", "content": unlinkedIssueAnswer}
					break
				}
				if !strings.Contains(toolResults[0], "BROWSER_ISSUE_FACT_17") || !strings.Contains(toolResults[0], accountIssueURL) || !strings.Contains(toolResults[0], `"repo":"owner/project"`) {
					http.Error(w, "account search did not return a selectable Issue and source", http.StatusBadRequest)
					return
				}
				toolName, toolID, arguments = "lain42_github_issue", "read-account-issue-17", `{"repo":"owner/project","number":17}`
			case 2:
				if !strings.Contains(toolResults[1], "DETAIL_ISSUE_FACT_17") || !strings.Contains(toolResults[1], "DISCUSSION_ISSUE_FACT_17") || !strings.Contains(toolResults[1], accountIssueURL) {
					http.Error(w, "selected Issue detail and discussion did not reach final inference", http.StatusBadRequest)
					return
				}
				delta = map[string]any{"role": "assistant", "content": accountIssueAnswer}
			default:
				http.Error(w, "account Issue workflow repeated a completed tool step", http.StatusBadRequest)
				return
			}
			if delta == nil {
				finish = "tool_calls"
				delta = map[string]any{"role": "assistant", "tool_calls": []any{map[string]any{
					"index": 0, "id": toolID, "type": "function", "function": map[string]any{
						"name": toolName, "arguments": arguments}}}}
			}
		} else if strings.Contains(latestUser, "Describe the scoped image.") {
			if !scopedImageRead || len(inference.Tools) != 0 {
				http.Error(w, "scoped image input must reach the model without additional tools", http.StatusBadRequest)
				return
			}
			delta = map[string]any{"role": "assistant", "content": "The scoped image bytes reached the model without account tools."}
		} else if browserGate != nil {
			browserGate.startOnce.Do(func() { close(browserGate.started) })
			select {
			case <-browserGate.released:
				delta = map[string]any{"role": "assistant", "content": "Recovered " + browserViewport + " without another inference."}
			case <-r.Context().Done():
				browserGate.cancelOnce.Do(func() { close(browserGate.canceled) })
				return
			}
		} else if strings.Contains(latestUser, "Continue after stopping this browser task for desktop.") {
			delta = map[string]any{"role": "assistant", "content": "New desktop task completed after Stop."}
		} else if strings.Contains(latestUser, "Continue after stopping this browser task for mobile.") {
			delta = map[string]any{"role": "assistant", "content": "New mobile task completed after Stop."}
		} else if strings.Contains(latestUser, recoveryPrompt) {
			select {
			case recoveryStarted <- struct{}{}:
			default:
			}
			select {
			case <-recoveryReleased:
				delta = map[string]any{"role": "assistant", "content": recoveryAnswer}
			case <-r.Context().Done():
				return
			}
		} else if strings.Contains(latestUser, "阅读我的项目 issue 并回复尝试解决") {
			browserIssueInferenceCalls.Add(1)
			if strings.Contains(currentTurnEvidence, "BROWSER_ISSUE_FACT_17") && strings.Contains(currentTurnEvidence, "https://github.com/owner/project/issues/17") {
				delta = map[string]any{"role": "assistant", "content": "Issue #17 reports lost completed item IDs on refresh. Save a durable batch manifest after each item and restore it before retrying. Source: https://github.com/owner/project/issues/17. No repository change or comment was published."}
			} else if strings.Contains(currentTurnEvidence, "GitHub OAuth request failed (HTTP 401)") && !strings.Contains(currentTurnEvidence, "BROWSER_ISSUE_FACT_17") {
				delta = map[string]any{"role": "assistant", "content": "No issue content was read for this account. Connect GitHub on this website and retry; local gh login and a paired device are not required."}
			} else {
				http.Error(w, "the current browser issue evidence or its honest OAuth failure did not reach DSH", http.StatusBadRequest)
				return
			}
		} else if strings.Contains(latestUser, "What does that Rust code print?") {
			if !strings.Contains(string(body), "fn main()") || !strings.Contains(string(body), "The attached note contains CLIENT_FILE_FACT_42.") {
				http.Error(w, "the previous code answer did not reach follow-up inference", http.StatusBadRequest)
				return
			}
			delta = map[string]any{"role": "assistant", "content": "That Rust code prints CLIENT_FILE_FACT_42."}
		} else if strings.Contains(latestUser, "Explain my attached browser note") {
			if !strings.Contains(string(body), "CLIENT_FILE_FACT_42") {
				http.Error(w, "client attachment did not reach inference", http.StatusBadRequest)
				return
			}
			delta = map[string]any{"role": "assistant", "content": "The attached note contains CLIENT_FILE_FACT_42.\n\n```rust\nfn main() { println!(\"CLIENT_FILE_FACT_42\"); }\n```"}
		} else if strings.Contains(latestUser, "Say hello for the second account") {
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
			"api": "openai-completions", "baseURL": controlPlane.URL + "/v1/agent", "apiKeyEnv": "LAIN42_COMPOSITION_KEY", "models": []any{map[string]any{"id": "gpt-3.5-turbo", "input": []string{"text", "image"}}}}}}},
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
	turnA := dto.AgentDSHTurnRequest{SessionID: sessionA, RequestID: "44444444-4444-4444-8444-444444444444", Model: "gpt-3.5-turbo", Text: "Read " + issueURL + " and propose a fix based on its discussion.", ToolScope: "account-read"}
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
	stop, origin = startCompositionDSH(t, root, work, patch, controlPlane.URL, secret)
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
	changedScope := turnA
	changedScope.ToolScope = "public-only"
	status, body = post(tokenA, "/api/agent/dsh/turns", changedScope)
	require.Equal(t, http.StatusConflict, status, body)
	require.Contains(t, body, "AGENT_DSH_REQUEST_CONFLICT")
	require.EqualValues(t, 3, providerCalls.Load(), "changing replay permissions must not reinfer")
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
	// Lose the browser observer while the real runtime is still awaiting its
	// external model. This is transport loss, not an explicit Stop command.
	recoveryTurn := dto.AgentDSHTurnRequest{SessionID: sessionA,
		RequestID: "55555555-5555-4555-8555-555555555555", Model: turnA.Model, Text: recoveryPrompt}
	recoveryBody, err := json.Marshal(recoveryTurn)
	require.NoError(t, err)
	observerContext, disconnectObserver := context.WithCancel(context.Background())
	defer disconnectObserver()
	observerRequest, err := http.NewRequestWithContext(observerContext, http.MethodPost,
		controlPlane.URL+"/api/agent/dsh/turns", strings.NewReader(string(recoveryBody)))
	require.NoError(t, err)
	observerRequest.Header.Set("Authorization", "Bearer "+tokenA)
	observerRequest.Header.Set("Content-Type", "application/json")
	observerResult := make(chan error, 1)
	go func() {
		response, requestErr := (&http.Client{Timeout: 140 * time.Second}).Do(observerRequest)
		if response != nil {
			_ = response.Body.Close()
		}
		observerResult <- requestErr
	}()
	select {
	case <-recoveryStarted:
	case <-time.After(15 * time.Second):
		t.Fatal("the original inference did not start before disconnect")
	}
	disconnectObserver()
	select {
	case requestErr := <-observerResult:
		require.ErrorIs(t, requestErr, context.Canceled)
	case <-time.After(15 * time.Second):
		t.Fatal("the original observer did not disconnect")
	}
	releaseRecovery()
	status, body = post(tokenA, "/api/agent/dsh/turns", recoveryTurn)
	require.Equal(t, http.StatusOK, status, body)
	require.Contains(t, body, recoveryAnswer)
	require.EqualValues(t, 4, providerCalls.Load(), "a lost response must recover the original inference, not start another")
	require.EqualValues(t, 2, githubCalls.Load(), "observer recovery must not repeat tool reads")
	var cancellationCount int64
	require.NoError(t, db.Model(&model.AgentDSHRequest{}).Where("cancel_requested = ?", true).Count(&cancellationCount).Error)
	require.Zero(t, cancellationCount, "transport loss must not create an explicit Stop intent")
	// Run the production build, not a DOM fixture or a route-intercepted UI.
	// Password login, refresh cookie, Agent turns and attachment conversion use
	// the real browser and server. The provider remains the declared fixture.
	browserScript, err := filepath.Abs("scripts/lain42-browser-acceptance.mjs")
	require.NoError(t, err)
	browserContext, cancelBrowser := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancelBrowser()
	browser := exec.CommandContext(browserContext, "node", browserScript, controlPlane.URL)
	browser.Env = append(os.Environ(), "LAIN42_BROWSER_MODEL_FIXTURE="+provider.URL)
	browser.Stdout, browser.Stderr = os.Stdout, os.Stderr
	require.NoError(t, browser.Run())
	require.EqualValues(t, 16, providerCalls.Load(), "each viewport also submits its current OAuth Issue evidence to DSH once")
	require.EqualValues(t, 2, browserIssueInferenceCalls.Load(), "both browser account outcomes must reach the actual DSH model adapter")
	require.EqualValues(t, 1, accountIssueSearchCalls.Load(), "only the linked account may search its own open issues")
	require.EqualValues(t, 3, githubCalls.Load(), "the unlinked account and unrelated browser chat must not query GitHub")
	require.NoError(t, db.Model(&model.AgentDSHRequest{}).Where("cancel_requested = ?", true).Count(&cancellationCount).Error)
	require.EqualValues(t, 2, cancellationCount, "only the two explicit browser Stops create cancellation intent")
	for _, account := range []struct {
		user  model.User
		calls int
	}{{owner, 8}, {other, 6}} {
		var updated model.User
		require.NoError(t, db.First(&updated, account.user.Id).Error)
		require.Equal(t, account.user.Quota-account.calls*40, updated.Quota,
			"completed work charges its owner once; Stop before provider output refunds its reservation")
		var logs []model.Log
		require.NoError(t, db.Where("user_id = ? AND type = ?", account.user.Id, model.LogTypeConsume).Find(&logs).Error)
		require.Len(t, logs, account.calls)
		for _, entry := range logs {
			require.Equal(t, 40, entry.Quota)
			require.Zero(t, entry.TokenId)
		}
	}
	imageTurn := dto.AgentDSHTurnRequest{SessionID: sessionA,
		RequestID: "66666666-6666-4666-8666-666666666666", Model: turnA.Model,
		Text: "Describe the scoped image.", ToolScope: "evidence-only",
		Images: []dto.AgentDSHTurnImage{{MediaType: "image/png", Data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC"}}}
	status, body = post(tokenA, "/api/agent/dsh/turns", imageTurn)
	require.Equal(t, http.StatusOK, status, body)
	require.Contains(t, body, "The scoped image bytes reached the model without account tools.")
	status, body = post(tokenB, "/api/agent/dsh/turns", imageTurn)
	require.Equal(t, http.StatusNotFound, status, body)
	status, body = post(tokenA, "/api/agent/dsh/turns", imageTurn)
	require.Equal(t, http.StatusOK, status, body)
	require.EqualValues(t, 17, providerCalls.Load(), "scoped image replay and foreign ownership must not reinfer")
	require.EqualValues(t, 3, githubCalls.Load(), "scoped image analysis must not read account data")
	var imageOwner model.User
	require.NoError(t, db.First(&imageOwner, owner.Id).Error)
	require.Equal(t, owner.Quota-9*40, imageOwner.Quota, "scoped image replay is charged only once")
	// No repository or Issue number is supplied by the caller. The actual DSH
	// loop must search the account, select the returned Issue, read its discussion,
	// and continue with an answer. The other account has no linked credential.
	accountIssueSession, unlinkedIssueSession := create(tokenA), create(tokenB)
	accountIssueTurn := dto.AgentDSHTurnRequest{SessionID: accountIssueSession,
		RequestID: "77777777-7777-4777-8777-777777777777", Model: turnA.Model,
		Text: accountIssuesPrompt, ToolScope: "account-read"}
	unlinkedIssueTurn := accountIssueTurn
	unlinkedIssueTurn.SessionID = unlinkedIssueSession
	issueTurns := []struct {
		token   string
		request dto.AgentDSHTurnRequest
		answer  string
	}{{tokenA, accountIssueTurn, accountIssueAnswer}, {tokenB, unlinkedIssueTurn, unlinkedIssueAnswer}}
	for _, turn := range issueTurns {
		status, body = post(turn.token, "/api/agent/dsh/turns", turn.request)
		require.Equal(t, http.StatusOK, status, body)
		require.Contains(t, body, turn.answer)
		require.NotContains(t, body, "synthetic-owner-github-token")
	}
	require.EqualValues(t, 22, providerCalls.Load(), "account search and detail need three inferences; honest unlinked recovery needs two")
	require.EqualValues(t, 2, accountIssueSearchCalls.Load(), "only the owner can perform browser-prepared and model-driven Issue searches")
	require.EqualValues(t, 6, githubCalls.Load(), "model-driven search, detail and discussion must use only the linked account")
	status, body = post(tokenB, "/api/agent/dsh/turns", accountIssueTurn)
	require.Equal(t, http.StatusNotFound, status, body)
	stop()
	_, origin = startCompositionDSH(t, root, work, patch, controlPlane.URL, secret)
	t.Setenv("LAIN42_DSH_BASE_URL", origin)
	for _, turn := range issueTurns {
		status, body = post(turn.token, "/api/agent/dsh/turns", turn.request)
		require.Equal(t, http.StatusOK, status, body)
		require.Contains(t, body, turn.answer)
	}
	require.EqualValues(t, 22, providerCalls.Load(), "both account outcomes must replay after runtime restart without inference")
	require.EqualValues(t, 6, githubCalls.Load(), "durable replay and foreign access must not repeat account reads")
	issueFollowUp := dto.AgentDSHTurnRequest{SessionID: accountIssueSession,
		RequestID: "88888888-8888-4888-8888-888888888888", Model: turnA.Model,
		Text: accountIssueFollowUp, ToolScope: "evidence-only"}
	status, body = post(tokenA, "/api/agent/dsh/turns", issueFollowUp)
	require.Equal(t, http.StatusOK, status, body)
	require.Contains(t, body, accountIssueFollowUpAnswer)
	require.EqualValues(t, 23, providerCalls.Load(), "a follow-up must use the recovered Issue context once")
	require.EqualValues(t, 6, githubCalls.Load(), "an evidence-only follow-up must not search account data again")
	for _, account := range []struct {
		user  model.User
		calls int
	}{{owner, 13}, {other, 8}} {
		var updated model.User
		require.NoError(t, db.First(&updated, account.user.Id).Error)
		require.Equal(t, account.user.Quota-account.calls*40, updated.Quota)
		require.Equal(t, account.calls*40, updated.UsedQuota)
		var logs []model.Log
		require.NoError(t, db.Where("user_id = ? AND type = ?", account.user.Id, model.LogTypeConsume).Find(&logs).Error)
		require.Len(t, logs, account.calls, "replay and foreign access must never create another charge")
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
type compositionRuntimeOptions struct {
	diagnostics io.Writer
	lifetime    time.Duration
}

func startCompositionDSH(t *testing.T, root, work, patch, controlPlane, secret string, options ...compositionRuntimeOptions) (func(), string) {
	t.Helper()
	lifetime := 4 * time.Minute
	diagnostics := io.Writer(os.Stderr)
	if len(options) > 0 {
		lifetime, diagnostics = options[0].lifetime, options[0].diagnostics
	}
	ctx, cancel := context.WithTimeout(context.Background(), lifetime)
	command := exec.CommandContext(ctx, "node", "--no-experimental-strip-types", filepath.Join(root, "apps/cli/lib/bin.js"),
		"--profile", "web", "--patch", patch, "--host", "127.0.0.1", "--port", "0", "--no-open")
	command.Dir = work
	command.Env = append(os.Environ(), "DSH_HOME="+filepath.Join(work, "home"), "DSH_AGENTS_HOME="+filepath.Join(work, ".agents"),
		"DSH_TELEMETRY_DISABLED=1", "NODE_NO_WARNINGS=1", "LAIN42_COMPOSITION_KEY=synthetic-model-only-key",
		"LAIN42_DSH_BRIDGE_SECRET="+secret, "LAIN42_AGENT_MODEL_RELAY_SECRET="+secret,
		"LAIN42_AGENT_TOOL_RELAY_URL="+controlPlane+"/api/agent/bridge/v1/tool",
		"HTTP_PROXY=", "HTTPS_PROXY=", "ALL_PROXY=", "NODE_OPTIONS=", "NODE_PATH=", "TSX_TSCONFIG_PATH=")
	// The optional prototype key belongs only to the test's upstream boundary;
	// the DSH child must know only the synthetic model-relay credential.
	filtered := command.Env[:0]
	for _, value := range command.Env {
		if !strings.HasPrefix(value, "LAIN42_PROTOTYPE_NVIDIA_KEY=") {
			filtered = append(filtered, value)
		}
	}
	command.Env = filtered
	stdout, err := command.StdoutPipe()
	require.NoError(t, err)
	command.Stderr = diagnostics
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
