//go:build lain42composition && lain42live

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
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

const prototypeModel = "nvidia/nemotron-3-super-120b-a12b"

// Opt-in Actions only: actual New API and DSH, a real developer-trial model,
// and synthetic account-owned GitHub data. This is not production OAuth or a
// commercial capacity certification. Missing credentials fail, never skip.
func TestLiveDSHNewAPIPrototype(t *testing.T) {
	runLiveDSHNewAPIPrototype(t, "issue")
}

func TestLiveDSHNewAPIResearchPrototype(t *testing.T) {
	runLiveDSHNewAPIPrototype(t, "research")
}

func TestLiveDSHNewAPIClientResearchPrototype(t *testing.T) {
	runLiveDSHNewAPIPrototype(t, "client-research")
}

func runLiveDSHNewAPIPrototype(t *testing.T, scenario string) {
	t.Helper()
	research := scenario != "issue"
	clientOnly := scenario == "client-research"
	key := os.Getenv("LAIN42_PROTOTYPE_NVIDIA_KEY")
	require.True(t, strings.HasPrefix(key, "nvapi-"), "missing authorized NVIDIA prototype credential")
	root := os.Getenv("LAIN42_COMPOSITION_DSH_ROOT")
	require.NotEmpty(t, root)
	_, err := os.Stat(filepath.Join(root, "apps/cli/lib/bin.js"))
	require.NoError(t, err)
	evidence := os.Getenv("LAIN42_PROTOTYPE_EVIDENCE_DIR")
	require.NotEmpty(t, evidence)
	require.NoError(t, os.MkdirAll(evidence, 0700))
	var providerCalls, githubCalls atomic.Int32
	var searchCalls atomic.Int32
	var officialSearchSource atomic.Bool
	searchObservation := &prototypeSearchObservation{queries: make(map[string]struct{})}
	var denial atomic.Int32
	passed := false
	mobileBrowser := false
	t.Cleanup(func() {
		// Deliberately omit raw requests, responses, runtime logs, credentials and
		// traces. The optional screenshot contains only declared synthetic data.
		// Failed inference is recorded as a failure, not empty success.
		scope := "Real trial inference + actual New API/DSH + Chromium mobile emulation; synthetic GitHub/accounts; not physical Android or production OAuth"
		if research {
			scope = "Real trial inference/public search + actual New API/DSH + mobile Chromium client WASM page read; synthetic accounts/document; not physical Android or production OAuth"
		}
		if clientOnly {
			scope = "Independent mobile Chromium public GitHub search/client WASM page read + actual New API/DSH/trial inference; synthetic accounts/document; does not test hosted Bing search, physical Android or production OAuth"
		}
		result := map[string]any{"passed": passed && !t.Failed(), "model": prototypeModel,
			"mobile_browser_emulation":      mobileBrowser,
			"mobile_account_history_switch": mobileBrowser && !research, "foreign_turn_and_cancel_denied": mobileBrowser && !research,
			"mobile_research_flow": mobileBrowser && research, "public_search_requests": searchCalls.Load(),
			"client_research_only":                  clientOnly,
			"official_search_source_returned":       officialSearchSource.Load(),
			"public_search_empty_rss_responses":     searchObservation.empty.Load(),
			"public_search_invalid_rss_responses":   searchObservation.invalid.Load(),
			"public_search_non_200_responses":       searchObservation.nonOK.Load(),
			"public_search_repeated_origin_queries": searchObservation.repeated.Load(),
			"external_attempts":                     providerCalls.Load(), "github_reads": githubCalls.Load(),
			"upstream_denial_status": denial.Load(), "request_ceiling": 6, "output_token_ceiling": 1024,
			"scope": scope}
		data, marshalErr := json.MarshalIndent(result, "", "  ")
		require.NoError(t, marshalErr)
		require.NoError(t, os.WriteFile(filepath.Join(evidence, "prototype.json"), data, 0600))
	})

	require.NoError(t, i18n.Init())
	common.IsMasterNode = true
	common.SQLitePath = filepath.Join(t.TempDir(), "live-prototype.db")
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
	common.CryptoSecret = "synthetic-prototype-at-rest-secret"
	common.SessionCookieSecure = false
	common.RetryTimes = 0
	common.SetPerformanceMonitorConfig(common.PerformanceMonitorConfig{})
	setting.ModelRequestRateLimitEnabled, constant.CountToken = false, false
	constant.StreamingTimeout = 50
	gin.SetMode(gin.TestMode)
	require.NoError(t, ratio_setting.UpdateModelRatioByJSONString(`{"`+prototypeModel+`":1}`))
	require.NoError(t, ratio_setting.UpdateCompletionRatioByJSONString(`{"`+prototypeModel+`":2}`))
	require.NoError(t, ratio_setting.UpdateGroupRatioByJSONString(`{"default":1}`))
	require.NoError(t, db.AutoMigrate(&model.User{}, &model.Token{}, &model.Channel{}, &model.Ability{}, &model.Log{},
		&model.AgentDSHSession{}, &model.AgentDSHRequest{}, &model.AuthFlow{}, &model.AgentGitHubCredential{}))
	token := strings.Repeat("p", 32)
	owner := model.User{Username: "prototype-owner", Role: common.RoleCommonUser, Status: common.UserStatusEnabled,
		Group: "default", AuthVersion: 1, Quota: 100000, AffCode: "prototype-owner-aff", Setting: `{"billing_preference":"wallet_only"}`}
	owner.SetAccessToken(token)
	passwordHash, err := common.Password2Hash("synthetic-prototype-browser-password")
	require.NoError(t, err)
	owner.Password = passwordHash
	require.NoError(t, db.Create(&owner).Error)
	other := model.User{Username: "prototype-other", Password: passwordHash, Role: common.RoleCommonUser, Status: common.UserStatusEnabled,
		Group: "default", AuthVersion: 1, Quota: 12345, AffCode: "prototype-other-aff"}
	require.NoError(t, db.Create(&other).Error)
	require.NoError(t, db.Create(&model.User{Username: "prototype-root", Password: passwordHash,
		Role: common.RoleRootUser, Status: common.UserStatusEnabled, Group: "default", AuthVersion: 1, AffCode: "prototype-root-aff"}).Error)
	model.CheckSetup()
	require.True(t, constant.Setup)
	const githubKey = "synthetic-prototype-github-key"
	const relaySecret = "synthetic-prototype-model-relay-secret"
	// A literal owner/project URL reads as an unresolved placeholder to a real
	// model. Use an unambiguous synthetic repository without adding answer facts
	// to the user instruction; both markers must still come from the Issue tool.
	const issueURL = "https://github.com/lain42-acceptance/export-workbench/issues/2"
	require.NoError(t, model.SaveAgentGitHubCredential(owner.Id, "prototype-owner", "lain42-acceptance", "repo", githubKey))
	github := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		githubCalls.Add(1)
		if r.Method != http.MethodGet || r.Header.Get("Authorization") != "Bearer "+githubKey {
			http.Error(w, "wrong account", http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/repos/lain42-acceptance/export-workbench/issues/2":
			_, _ = io.WriteString(w, `{"number":2,"state":"closed","title":"Export retry","body":"A reconnect creates duplicate exports. Diagnostic marker: ORBIT_EXPORT_731.","comments":1,"html_url":"`+issueURL+`"}`)
		case "/repos/lain42-acceptance/export-workbench/issues/2/comments":
			_, _ = io.WriteString(w, `[{"body":"Persist the request identifier before starting export; reconnect still reproduces after a lost response. Discussion marker: DISCUSSION_927.","user":{"login":"maintainer"}}]`)
		default:
			http.Error(w, "unexpected GitHub resource", http.StatusNotFound)
		}
	}))
	t.Cleanup(github.Close)
	originalTransport := http.DefaultTransport
	http.DefaultTransport = compositionGitHubTransport{delegate: originalTransport, origin: github.URL}
	if research {
		t.Setenv("AGENT_WEB_SEARCH_URL", "")
		http.DefaultTransport = prototypeResearchTransport{delegate: http.DefaultTransport, calls: &searchCalls, official: &officialSearchSource, observation: searchObservation}
	}
	t.Cleanup(func() { http.DefaultTransport = originalTransport })
	// Keep the actual key only at this external test boundary. The application's
	// provider adapter still performs a real canonical request and usage billing.
	client := &http.Client{Timeout: 50 * time.Second, Transport: originalTransport,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/chat/completions" || r.Header.Get("Authorization") != "Bearer synthetic-prototype-channel-key" {
			http.Error(w, "invalid prototype route", http.StatusBadRequest)
			return
		}
		body, readErr := io.ReadAll(io.LimitReader(r.Body, 64*1024+1))
		if readErr != nil || len(body) > 64*1024 || bytes.Contains(body, []byte(key)) || bytes.Contains(body, []byte(githubKey)) || bytes.Contains(body, []byte(relaySecret)) {
			http.Error(w, "unsafe or oversized prototype input", http.StatusBadRequest)
			return
		}
		var payload map[string]any
		if json.Unmarshal(body, &payload) != nil || payload["model"] != prototypeModel {
			http.Error(w, "unexpected prototype model", http.StatusBadRequest)
			return
		}
		if denial.Load() != 0 {
			http.Error(w, "prototype budget exhausted; no retries or fallback", http.StatusServiceUnavailable)
			return
		}
		// Explicit test-only sampling/output policy; history and tools are untouched.
		payload["max_tokens"] = 1024
		payload["chat_template_kwargs"] = map[string]any{"enable_thinking": false}
		delete(payload, "reasoning_effort")
		delete(payload, "max_completion_tokens")
		body, _ = json.Marshal(payload)
		upstream, requestErr := http.NewRequestWithContext(r.Context(), http.MethodPost,
			"https://integrate.api.nvidia.com/v1/chat/completions", bytes.NewReader(body))
		if requestErr != nil {
			http.Error(w, "prototype request failed", http.StatusBadGateway)
			return
		}
		upstream.Header.Set("Authorization", "Bearer "+key)
		upstream.Header.Set("Content-Type", "application/json")
		for {
			attempts := providerCalls.Load()
			if attempts >= 6 {
				http.Error(w, "prototype budget exhausted; no retries or fallback", http.StatusServiceUnavailable)
				return
			}
			if providerCalls.CompareAndSwap(attempts, attempts+1) {
				break
			}
		}
		response, requestErr := client.Do(upstream)
		if requestErr != nil {
			denial.Store(-1)
			http.Error(w, "prototype network failure; no retry", http.StatusBadGateway)
			return
		}
		defer response.Body.Close()
		if response.StatusCode != http.StatusOK {
			denial.Store(int32(response.StatusCode))
			// No raw provider error body or redirected request is exposed.
			http.Error(w, fmt.Sprintf("prototype upstream denied HTTP %d; no retry", response.StatusCode), response.StatusCode)
			return
		}
		w.Header().Set("Content-Type", response.Header.Get("Content-Type"))
		_, _ = io.Copy(w, io.LimitReader(response.Body, 2*1024*1024))
	}))
	t.Cleanup(provider.Close)
	baseURL := provider.URL
	channel := model.Channel{Type: constant.ChannelTypeOpenAI, Key: "synthetic-prototype-channel-key", Status: common.ChannelStatusEnabled,
		Name: "prototype-only", Group: "default", Models: prototypeModel, BaseURL: &baseURL}
	require.NoError(t, channel.Insert())
	t.Setenv("LAIN42_DSH_BRIDGE_SECRET", relaySecret)
	t.Setenv("LAIN42_AGENT_MODEL_RELAY_SECRET", relaySecret)
	engine := gin.New()
	router.SetRouter(engine, router.WebAssets{BuildFS: buildFS, IndexPage: indexPage})
	controlPlane := httptest.NewServer(engine)
	t.Cleanup(controlPlane.Close)
	work := t.TempDir()
	patch := filepath.Join(work, "prototype.patch.yml")
	config := []any{
		map[string]any{"id": "web-runtime", "config": map[string]any{"openBrowser": false, "printUrl": true, "enableLain42Bridge": true}},
		map[string]any{"id": "session-title-llm", "disabled": true},
		map[string]any{"id": "agent-default-model", "config": map[string]any{"provider": "lain42-web", "model": prototypeModel}},
		map[string]any{"id": "llm-pi-ai", "config": map[string]any{"providers": map[string]any{"lain42-web": map[string]any{
			"api": "openai-completions", "baseURL": controlPlane.URL + "/v1/agent", "apiKeyEnv": "LAIN42_COMPOSITION_KEY",
			"retryPolicy": map[string]any{"mode": "normal", "maxRetries": 0}, "models": []any{map[string]any{"id": prototypeModel, "maxTokens": 1024}}}}}},
	}
	encoded, err := json.Marshal(config)
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(patch, encoded, 0600))
	runtimeOptions := compositionRuntimeOptions{diagnostics: io.Discard, lifetime: 6 * time.Minute}
	stop, origin := startCompositionDSH(t, root, work, patch, controlPlane.URL, relaySecret, runtimeOptions)
	t.Setenv("LAIN42_DSH_BASE_URL", origin)
	post := func(path string, data any) (int, []byte) {
		body, marshalErr := json.Marshal(data)
		require.NoError(t, marshalErr)
		request, requestErr := http.NewRequest(http.MethodPost, controlPlane.URL+path, bytes.NewReader(body))
		require.NoError(t, requestErr)
		request.Header.Set("Authorization", "Bearer "+token)
		request.Header.Set("Content-Type", "application/json")
		response, requestErr := (&http.Client{Timeout: 135 * time.Second}).Do(request)
		require.NoError(t, requestErr)
		defer response.Body.Close()
		result, readErr := io.ReadAll(io.LimitReader(response.Body, 1024*1024))
		require.NoError(t, readErr)
		return response.StatusCode, result
	}
	status, body := post("/api/agent/dsh/sessions", nil)
	require.Equal(t, http.StatusOK, status)
	var session struct {
		Data struct {
			SessionID string `json:"session_id"`
		}
	}
	require.NoError(t, json.Unmarshal(body, &session))
	require.Len(t, session.Data.SessionID, 64)
	turn := dto.AgentDSHTurnRequest{SessionID: session.Data.SessionID, Model: prototypeModel,
		RequestID: "99999999-9999-4999-8999-999999999991", Text: "Read " + issueURL + " and its discussion. Summarize the current state, quote both diagnostic markers exactly, propose the discussed fix, and cite the Issue URL. Do not just report OAuth status."}
	answerFor := func(request dto.AgentDSHTurnRequest) string {
		status, body := post("/api/agent/dsh/turns", request)
		require.Equal(t, http.StatusOK, status, "hosted turn failed; upstream denial status=%d", denial.Load())
		var response struct {
			Success bool
			Data    struct{ Answer string }
		}
		require.NoError(t, json.Unmarshal(body, &response))
		require.True(t, response.Success)
		require.NotEmpty(t, response.Data.Answer)
		require.NotContains(t, response.Data.Answer, key)
		return response.Data.Answer
	}
	if research {
		turn.Text = "Use web_search to find the official ast-grep GitHub repository from the public web. Return its repository name and source link, and explain its purpose in one sentence. Do not use my GitHub account, local CLI or devices."
	}
	answer := ""
	if !clientOnly {
		answer = answerFor(turn)
	}
	if research && !clientOnly {
		require.Contains(t, answer, "https://github.com/ast-grep/ast-grep")
		require.Regexp(t, `(?i)AST|syntax|structural`, answer)
		require.Positive(t, searchCalls.Load(), "the actual DSH tool must reach the public search service")
		require.True(t, officialSearchSource.Load(), "the official source must be returned by the actual search service")
		require.Zero(t, githubCalls.Load(), "public search must not read connected-account GitHub data")
	} else if !research {
		require.Contains(t, answer, "ORBIT_EXPORT_731")
		require.Contains(t, answer, "DISCUSSION_927")
		require.Contains(t, answer, issueURL)
		require.Contains(t, strings.ToLower(answer), "closed")
		require.Regexp(t, `(?i)persist|stor(?:e|ing)|sav(?:e|ing)`, answer)
		require.EqualValues(t, 2, githubCalls.Load(), "read actual Issue tool and discussion with the owner's OAuth credential")
		require.GreaterOrEqual(t, providerCalls.Load(), int32(2), "the real model must continue after the real tool")
		followup := turn
		followup.RequestID = "99999999-9999-4999-8999-999999999992"
		followup.Text = "What was the discussion marker in that Issue? Reply with the marker only; this is a follow-up to what you just read."
		require.Equal(t, "DISCUSSION_927", strings.TrimSpace(answerFor(followup)))
		ordinary := turn
		ordinary.RequestID = "99999999-9999-4999-8999-999999999994"
		ordinary.Text = "New topic: what is DeepSeek? In one English sentence say whether it is an AI company/model family or an academic search tool. This is stable common knowledge; do not search or revisit the export Issue."
		ordinaryAnswer := answerFor(ordinary)
		require.Regexp(t, `(?i)company|model family|models`, ordinaryAnswer)
		require.NotContains(t, ordinaryAnswer, "ORBIT_EXPORT_731")
		require.NotContains(t, ordinaryAnswer, "DeepWalker")
		require.NotContains(t, ordinaryAnswer, "OpenAlex")
		require.EqualValues(t, 2, githubCalls.Load(), "ordinary chat must not depend on another Issue read")
		attachment := turn
		attachment.RequestID = "99999999-9999-4999-8999-999999999993"
		attachment.Text = "[Lain42 client-prepared attachment]\nFile: note.txt\nATTACHMENT_FACT_548: the delivery color is indigo.\n\nCurrent user request:\nFrom this attached note, give its exact marker and delivery color in one sentence. Ignore the earlier export task for this answer."
		attachmentAnswer := answerFor(attachment)
		require.Contains(t, attachmentAnswer, "ATTACHMENT_FACT_548")
		require.Contains(t, strings.ToLower(attachmentAnswer), "indigo")
		require.NotContains(t, attachmentAnswer, "ORBIT_EXPORT_731")
	}
	// All scenarios use the built mobile UI and the six-request ceiling, with
	// no mocked auth, website API, final answer or browser storage state.
	scriptName := "scripts/lain42-live-browser-acceptance.mjs"
	if research {
		scriptName = "scripts/lain42-live-research-acceptance.mjs"
	}
	browserScript, err := filepath.Abs(scriptName)
	require.NoError(t, err)
	browserLifetime := 2 * time.Minute
	if research {
		browserLifetime = 3 * time.Minute
	}
	browserContext, cancelBrowser := context.WithTimeout(context.Background(), browserLifetime)
	defer cancelBrowser()
	browser := exec.CommandContext(browserContext, "node", browserScript, controlPlane.URL)
	for _, value := range os.Environ() {
		if !strings.HasPrefix(value, "LAIN42_PROTOTYPE_NVIDIA_KEY=") {
			browser.Env = append(browser.Env, value)
		}
	}
	// The replay payload contains only this synthetic/public browser turn and
	// answer. Keep it in the private test temp directory, outside the artifacts.
	replayPath := filepath.Join(t.TempDir(), "client-research-replay.json")
	if clientOnly {
		browser.Env = append(browser.Env, "LAIN42_RESEARCH_REPLAY_PATH="+replayPath)
	}
	browser.Stdout, browser.Stderr = os.Stdout, os.Stderr
	require.NoError(t, browser.Run())
	mobileBrowser = true
	if clientOnly {
		require.EqualValues(t, 3, providerCalls.Load(), "client search, page answer and follow-up each use one genuine inference")
		require.Zero(t, githubCalls.Load(), "client research must not read connected-account GitHub data")
		require.Zero(t, searchCalls.Load(), "client-only acceptance must not be labelled hosted Bing acceptance")
		replayData, err := os.ReadFile(replayPath)
		require.NoError(t, err)
		require.LessOrEqual(t, len(replayData), 128*1024)
		var replay struct {
			Request dto.AgentDSHTurnRequest `json:"request"`
			Answer  string                  `json:"answer"`
		}
		require.NoError(t, common.Unmarshal(replayData, &replay))
		require.Contains(t, replay.Request.Text, "https://github.com/ast-grep/ast-grep")
		require.Contains(t, replay.Answer, "https://github.com/ast-grep/ast-grep")
		turn, answer = replay.Request, replay.Answer
	} else if research {
		require.GreaterOrEqual(t, providerCalls.Load(), int32(5), "search continuation and three mobile answers require genuine inference")
		require.LessOrEqual(t, providerCalls.Load(), int32(6), "research keeps the existing request ceiling")
		require.Zero(t, githubCalls.Load(), "research must not read connected-account GitHub data")
	} else {
		require.EqualValues(t, 6, providerCalls.Load(), "the mobile file answer adds exactly one real inference")
		require.EqualValues(t, 2, githubCalls.Load(), "file questions must not read unrelated GitHub data")
	}
	beforeReplay := providerCalls.Load()
	stop()
	_, origin = startCompositionDSH(t, root, work, patch, controlPlane.URL, relaySecret, runtimeOptions)
	t.Setenv("LAIN42_DSH_BASE_URL", origin)
	require.Equal(t, answer, answerFor(turn), "restart must return the immutable answer for the original request")
	require.Equal(t, beforeReplay, providerCalls.Load(), "replay must not invoke the trial API again")
	var updated, unchanged model.User
	require.NoError(t, db.First(&updated, owner.Id).Error)
	require.NoError(t, db.First(&unchanged, other.Id).Error)
	var logs []model.Log
	require.NoError(t, db.Where("user_id = ? AND type = ?", owner.Id, model.LogTypeConsume).Find(&logs).Error)
	require.Len(t, logs, int(beforeReplay), "one actual owner charge per genuine model attempt")
	charged := 0
	for _, entry := range logs {
		require.Positive(t, entry.Quota)
		require.Zero(t, entry.TokenId)
		charged += entry.Quota
	}
	require.Equal(t, owner.Quota-charged, updated.Quota)
	require.Equal(t, charged, updated.UsedQuota)
	require.Equal(t, other.Quota, unchanged.Quota)
	var admissions []model.AgentDSHRequest
	require.NoError(t, db.Where("user_id = ?", owner.Id).Find(&admissions).Error)
	admissionCount := 5
	if research {
		admissionCount = 4
	}
	if clientOnly {
		admissionCount = 3
	}
	require.Len(t, admissions, admissionCount, "probes and replay must not reserve another owner turn")
	for _, request := range admissions {
		require.False(t, request.CancelRequested, "foreign cancellation must not alter the owner's durable intent")
	}
	var foreignAdmissions int64
	require.NoError(t, db.Model(&model.AgentDSHRequest{}).Where("user_id = ?", other.Id).Count(&foreignAdmissions).Error)
	require.Zero(t, foreignAdmissions, "foreign probes must not create a request for the second account")
	var tokenCount int64
	require.NoError(t, db.Model(&model.Token{}).Count(&tokenCount).Error)
	require.Zero(t, tokenCount)
	passed = true
}

// Observe real search responses without substituting data or exposing bodies.
type prototypeResearchTransport struct {
	delegate    http.RoundTripper
	calls       *atomic.Int32
	official    *atomic.Bool
	observation *prototypeSearchObservation
}

// Only counts leave the test process. Query identities remain in memory, scoped
// to the search origin so an ordinary cross-origin redirect is not a repeat.
type prototypeSearchObservation struct {
	empty, invalid, nonOK, repeated atomic.Int32
	mu                              sync.Mutex
	queries                         map[string]struct{}
}

func (observer prototypeResearchTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	if request.URL.Hostname() != "www.bing.com" && request.URL.Hostname() != "cn.bing.com" {
		return observer.delegate.RoundTrip(request)
	}
	if request.Header.Get("Authorization") != "" || request.Header.Get("Cookie") != "" {
		return nil, fmt.Errorf("public search must not receive account credentials")
	}
	observer.calls.Add(1)
	queryIdentity := request.URL.Hostname() + "\x00" + strings.ToLower(strings.Join(strings.Fields(request.URL.Query().Get("q")), " "))
	observer.observation.mu.Lock()
	if _, exists := observer.observation.queries[queryIdentity]; exists {
		observer.observation.repeated.Add(1)
	}
	observer.observation.queries[queryIdentity] = struct{}{}
	observer.observation.mu.Unlock()
	response, err := observer.delegate.RoundTrip(request)
	if err != nil {
		return response, err
	}
	body, readErr := io.ReadAll(io.LimitReader(response.Body, 1<<20+1))
	_ = response.Body.Close()
	if readErr != nil || len(body) > 1<<20 {
		return nil, fmt.Errorf("search response unreadable or oversized")
	}
	response.Body = io.NopCloser(bytes.NewReader(body))
	if response.StatusCode != http.StatusOK {
		observer.observation.nonOK.Add(1)
		return response, nil
	}
	var feed struct {
		XMLName xml.Name `xml:"rss"`
		Channel struct {
			Items []struct {
				Link string `xml:"link"`
			} `xml:"item"`
		} `xml:"channel"`
	}
	if xml.Unmarshal(body, &feed) != nil {
		observer.observation.invalid.Add(1)
		return response, nil
	}
	if len(feed.Channel.Items) == 0 {
		observer.observation.empty.Add(1)
	}
	for _, item := range feed.Channel.Items {
		if strings.TrimRight(strings.TrimSpace(item.Link), "/") == "https://github.com/ast-grep/ast-grep" {
			observer.official.Store(true)
		}
	}
	return response, nil
}
