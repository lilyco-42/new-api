package controller

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/dto"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
)

const (
	agentDSHTurnPath           = "/lain42/bridge/v1/turn"
	agentDSHTurnBodyLimit      = 12 * 1024 * 1024
	agentDSHTurnPromptLimit    = 24 * 1024
	agentDSHTurnMaxImages      = 4
	agentDSHTurnMaxImageBytes  = 8 * 1024 * 1024
	agentDSHTurnMaxImagesBytes = 8 * 1024 * 1024
	agentDSHTurnResponseLimit  = 256 * 1024
	agentDSHTurnTimeout        = 125 * time.Second
	agentDSHRelayPath          = "/api/agent/bridge/v1/tool"
	agentDSHRelayBodyLimit     = 32 * 1024
	agentDSHRequestIDPattern   = model.AgentDSHRequestIDPattern
	agentDSHModelNamePattern   = `^[A-Za-z0-9._:/-]{1,128}$`
	agentDSHToolQueryMaxRunes  = 200
	agentDSHToolSearchMaxItems = 8
)

var (
	agentDSHTurnRequestID = regexp.MustCompile(agentDSHRequestIDPattern)
	agentDSHTurnModelName = regexp.MustCompile(agentDSHModelNamePattern)
)

type agentDSHWireTurnRequest struct {
	Version   int                     `json:"version"`
	SessionID string                  `json:"sessionId"`
	RequestID string                  `json:"requestId"`
	Model     string                  `json:"model"`
	Mode      string                  `json:"mode,omitempty"`
	Text      string                  `json:"text"`
	Images    []dto.AgentDSHTurnImage `json:"images,omitempty"`
	ToolScope string                  `json:"toolScope,omitempty"`
}

type agentDSHWireTurnResponse struct {
	Version   int    `json:"version"`
	RequestID string `json:"requestId"`
	Answer    string `json:"answer"`
}

// AgentDSHStatus reports configuration readiness without disclosing the
// private DSH URL or either server-to-server secret.
func AgentDSHStatus(c *gin.Context) {
	_, endpointErr := configuredAgentDSHEndpoint(agentDSHTurnPath)
	configured := endpointErr == nil && len(os.Getenv("LAIN42_DSH_BRIDGE_SECRET")) >= 32 && len(os.Getenv("LAIN42_AGENT_MODEL_RELAY_SECRET")) >= 32
	common.ApiSuccess(c, gin.H{"configured": configured})
}

// CreateAgentDSHSession creates an opaque server-owned session identity for a
// logged-in account. The opaque id is not a bearer credential.
func CreateAgentDSHSession(c *gin.Context) {
	session, err := model.CreateAgentDSHSession(c.GetInt("id"), time.Now().UTC())
	if err != nil {
		writeAgentError(c, http.StatusInternalServerError, "AGENT_DSH_SESSION_FAILED", "unable to create an Agent session")
		return
	}
	common.ApiSuccess(c, gin.H{"session_id": session.SessionId, "created_at": session.CreatedAt})
}

// AgentDSHTurn forwards an authenticated user's turn to the private DSH
// runtime. The account/session owner is verified here; DSH never receives the
// user's browser credential.
func AgentDSHTurn(c *gin.Context) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, agentDSHTurnBodyLimit)
	storage, err := common.GetBodyStorage(c)
	if err != nil {
		var maxBytesError *http.MaxBytesError
		if errors.As(err, &maxBytesError) || common.IsRequestBodyTooLargeError(err) {
			writeAgentError(c, http.StatusRequestEntityTooLarge, "AGENT_DSH_INVALID_REQUEST", "Agent request is too large")
			return
		}
		writeAgentError(c, http.StatusBadRequest, "AGENT_DSH_INVALID_REQUEST", "invalid Agent request")
		return
	}
	if storage.Size() <= 0 || storage.Size() > agentDSHTurnBodyLimit {
		writeAgentError(c, http.StatusRequestEntityTooLarge, "AGENT_DSH_INVALID_REQUEST", "Agent request is too large")
		return
	}
	body, err := storage.Bytes()
	if err != nil || len(body) == 0 {
		writeAgentError(c, http.StatusRequestEntityTooLarge, "AGENT_DSH_INVALID_REQUEST", "Agent request is too large")
		return
	}
	var request dto.AgentDSHTurnRequest
	if err := common.Unmarshal(body, &request); err != nil || !validAgentDSHTurnRequest(request) {
		writeAgentError(c, http.StatusBadRequest, "AGENT_DSH_INVALID_REQUEST", "invalid Agent request")
		return
	}
	if _, err := model.GetOwnedAgentDSHSession(c.GetInt("id"), request.SessionID); errors.Is(err, model.ErrAgentDSHSessionNotFound) {
		writeAgentError(c, http.StatusNotFound, "AGENT_DSH_SESSION_NOT_FOUND", "Agent session was not found")
		return
	} else if err != nil {
		writeAgentError(c, http.StatusInternalServerError, "AGENT_DSH_SESSION_UNAVAILABLE", "Agent session is temporarily unavailable")
		return
	}
	endpoint, err := configuredAgentDSHEndpoint(agentDSHTurnPath)
	secret := os.Getenv("LAIN42_DSH_BRIDGE_SECRET")
	if err != nil || len(secret) < 32 {
		writeAgentError(c, http.StatusServiceUnavailable, "AGENT_DSH_UNAVAILABLE", "The hosted Agent runtime is not configured")
		return
	}
	mode := request.Mode
	if mode == "" {
		mode = "general"
	}
	version := 1
	if len(request.Images) > 0 {
		version = 2
	}
	if request.ToolScope != "" {
		version = 3
	}
	wireRequest := agentDSHWireTurnRequest{
		Version:   version,
		SessionID: request.SessionID,
		RequestID: strings.ToLower(request.RequestID),
		Model:     request.Model,
		Mode:      mode,
		Text:      request.Text,
		Images:    request.Images,
		ToolScope: request.ToolScope,
	}
	wireBody, err := common.Marshal(wireRequest)
	if err != nil || len(wireBody) > agentDSHTurnBodyLimit {
		writeAgentError(c, http.StatusBadRequest, "AGENT_DSH_INVALID_REQUEST", "Agent request is too large")
		return
	}
	timestamp := strconv.FormatInt(time.Now().UTC().Unix(), 10)
	nonceBytes := make([]byte, 16)
	if _, err := rand.Read(nonceBytes); err != nil {
		writeAgentError(c, http.StatusInternalServerError, "AGENT_DSH_UNAVAILABLE", "The hosted Agent runtime is temporarily unavailable")
		return
	}
	nonce := hex.EncodeToString(nonceBytes)
	signature := signAgentDSHTurn(secret, timestamp, nonce, wireBody)
	outbound, err := http.NewRequestWithContext(c.Request.Context(), http.MethodPost, endpoint, strings.NewReader(string(wireBody)))
	if err != nil {
		writeAgentError(c, http.StatusInternalServerError, "AGENT_DSH_UNAVAILABLE", "The hosted Agent runtime is temporarily unavailable")
		return
	}
	outbound.Header.Set("Accept", "application/json")
	outbound.Header.Set("Content-Type", "application/json")
	outbound.Header.Set("X-Lain42-Timestamp", timestamp)
	outbound.Header.Set("X-Lain42-Nonce", nonce)
	outbound.Header.Set("X-Lain42-Signature", signature)
	client := &http.Client{
		Timeout: agentDSHTurnTimeout,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	// Reserve the account-owned identity before crossing the runtime boundary.
	// A persisted Stop must never be cleared by a retry. This admission fence
	// alone does not settle a task that was already forwarded to DSH.
	reservation, err := model.ReserveOwnedAgentDSHRequestWithToolScope(c.GetInt("id"), request.SessionID, wireRequest.RequestID, request.ToolScope, time.Now().UTC())
	if errors.Is(err, model.ErrAgentDSHRequestConflict) {
		writeAgentError(c, http.StatusConflict, "AGENT_DSH_REQUEST_CONFLICT", "The accepted request changed. Start a new message; the old task was not automatically rerun.")
		return
	}
	if errors.Is(err, model.ErrAgentDSHSessionNotFound) {
		writeAgentError(c, http.StatusNotFound, "AGENT_DSH_SESSION_NOT_FOUND", "Agent session was not found")
		return
	}
	if errors.Is(err, model.ErrAgentDSHRequestLimit) {
		writeAgentError(c, http.StatusConflict, "AGENT_DSH_REQUEST_LIMIT", "This chat reached its request limit. Create a new chat to continue.")
		return
	}
	if err != nil {
		writeAgentError(c, http.StatusServiceUnavailable, "AGENT_DSH_ADMISSION_UNAVAILABLE", "The Agent could not safely accept this message. Retry the same message later.")
		return
	}
	if reservation.CancelRequested {
		writeAgentError(c, http.StatusConflict, "AGENT_DSH_CANCEL_REQUESTED", "Stop was requested for this message. The task was not resubmitted.")
		return
	}
	response, err := client.Do(outbound)
	if err != nil {
		writeAgentError(c, http.StatusBadGateway, "AGENT_DSH_TURN_FAILED", "The hosted Agent could not complete this turn")
		return
	}
	defer response.Body.Close()
	responseBody, err := io.ReadAll(io.LimitReader(response.Body, agentDSHTurnResponseLimit+1))
	if err != nil || len(responseBody) > agentDSHTurnResponseLimit {
		writeAgentError(c, http.StatusBadGateway, "AGENT_DSH_INVALID_RESPONSE", "The hosted Agent returned an invalid response")
		return
	}
	if response.StatusCode != http.StatusOK {
		var failure struct {
			Error string `json:"error"`
		}
		if common.Unmarshal(responseBody, &failure) == nil {
			switch {
			case response.StatusCode == http.StatusConflict && failure.Error == "request_id_conflict":
				writeAgentError(c, http.StatusConflict, "AGENT_DSH_REQUEST_CONFLICT", "The accepted request changed. Start a new message; the old task was not automatically rerun.")
				return
			case response.StatusCode == http.StatusGatewayTimeout && failure.Error == "agent_turn_timeout":
				writeAgentError(c, http.StatusGatewayTimeout, "AGENT_DSH_TURN_TIMEOUT", "This turn timed out. Start a new message to continue.")
				return
			case response.StatusCode == http.StatusBadGateway && failure.Error == "agent_turn_unavailable":
				writeAgentError(c, http.StatusBadGateway, "AGENT_DSH_RESULT_UNAVAILABLE", "The previous turn's result is unavailable. Start a new message; the old task was not automatically rerun.")
				return
			}
		}
		writeAgentError(c, http.StatusBadGateway, "AGENT_DSH_TURN_FAILED", "The hosted Agent could not complete this turn")
		return
	}
	var turn agentDSHWireTurnResponse
	if err := common.Unmarshal(responseBody, &turn); err != nil || turn.Version != 1 || turn.RequestID != wireRequest.RequestID || strings.TrimSpace(turn.Answer) == "" {
		writeAgentError(c, http.StatusBadGateway, "AGENT_DSH_INVALID_RESPONSE", "The hosted Agent returned an invalid response")
		return
	}
	common.ApiSuccess(c, gin.H{
		"session_id": request.SessionID,
		"request_id": turn.RequestID,
		"answer":     turn.Answer,
	})
}

func validAgentDSHTurnRequest(request dto.AgentDSHTurnRequest) bool {
	if !model.ValidAgentDSHToolScope(request.ToolScope) {
		return false
	}
	if len(request.SessionID) != 64 || !modelAgentDSHSessionIDPattern.MatchString(request.SessionID) {
		return false
	}
	if !agentDSHTurnRequestID.MatchString(request.RequestID) {
		return false
	}
	if len([]byte(request.Text)) > agentDSHTurnPromptLimit {
		return false
	}
	if len(request.Images) == 0 && strings.TrimSpace(request.Text) == "" {
		return false
	}
	if len(request.Images) > agentDSHTurnMaxImages {
		return false
	}
	totalImageBytes := 0
	for _, image := range request.Images {
		switch image.MediaType {
		case "image/png", "image/jpeg", "image/webp", "image/gif":
		default:
			return false
		}
		if image.Data == "" || len(image.Data) > base64.StdEncoding.EncodedLen(agentDSHTurnMaxImageBytes)+4 {
			return false
		}
		decoded, err := base64.StdEncoding.Strict().DecodeString(image.Data)
		if err != nil || len(decoded) == 0 || base64.StdEncoding.EncodeToString(decoded) != image.Data || len(decoded) > agentDSHTurnMaxImageBytes {
			return false
		}
		totalImageBytes += len(decoded)
		if totalImageBytes > agentDSHTurnMaxImagesBytes {
			return false
		}
	}
	if !agentDSHTurnModelName.MatchString(request.Model) {
		return false
	}
	return request.Mode == "" || request.Mode == "general" || request.Mode == "coding" || request.Mode == "research" || request.Mode == "content"
}

func configuredAgentDSHEndpoint(path string) (string, error) {
	return service.AgentDSHEndpoint(path)
}

func signAgentDSHTurn(secret, timestamp, nonce string, body []byte) string {
	return service.SignAgentDSHRequest(secret, timestamp, nonce, agentDSHTurnPath, body)
}

type agentDSHToolSearchArgs struct {
	Query string `json:"query"`
	Limit int    `json:"limit"`
}

type agentDSHToolRepositoryArgs struct {
	Limit int `json:"limit"`
}

type agentDSHToolActivityArgs struct {
	Repo  string `json:"repo"`
	State string `json:"state"`
	Limit int    `json:"limit"`
}

type agentDSHToolIssueArgs struct {
	Repo   string `json:"repo"`
	Number int    `json:"number"`
}

// AgentDSHToolRelay executes only the read-only tool names advertised by the
// Lain42 DSH preset. Middleware has verified the HMAC, one-use nonce, session
// owner, and enabled New API account before this handler runs.
func AgentDSHToolRelay(c *gin.Context) {
	storage, err := common.GetBodyStorage(c)
	if err != nil {
		writeAgentDSHToolError(c, "invalid_request", "The tool request could not be read")
		return
	}
	if storage.Size() <= 0 || storage.Size() > agentDSHRelayBodyLimit {
		writeAgentDSHToolError(c, "invalid_request", "The tool request exceeded its size limit")
		return
	}
	body, err := storage.Bytes()
	if err != nil || len(body) == 0 {
		writeAgentDSHToolError(c, "invalid_request", "The tool request exceeded its size limit")
		return
	}
	var request dto.AgentDSHToolRelayRequest
	if err := common.Unmarshal(body, &request); err != nil || (request.Version != 1 && request.Version != 2) || request.Arguments == nil || (request.Version == 1 && request.RequestID != "") {
		writeAgentDSHToolError(c, "invalid_request", "The tool request is invalid")
		return
	}
	if request.Version == 1 {
		requiresIdentity, err := model.OwnedAgentDSHSessionRequiresToolIdentity(c.GetInt("id"), request.SessionID)
		if err != nil {
			writeAgentDSHToolError(c, "tool_request_not_admitted", "The tool session could not be verified.")
			return
		}
		if requiresIdentity {
			writeAgentDSHToolError(c, "tool_request_identity_required", "This session requires an exact admitted request identity. Upgrade the hosted Agent before using its tools.")
			return
		}
	} else {
		admission, err := model.GetOwnedAgentDSHRequest(c.GetInt("id"), request.SessionID, request.RequestID)
		if err != nil {
			writeAgentDSHToolError(c, "tool_request_not_admitted", "The tool request could not be verified.")
			return
		}
		if admission.CancelRequested {
			writeAgentDSHToolError(c, "tool_request_cancelled", "Stop was requested for this message. No new tool was executed.")
			return
		}
		allowed := admission.ToolScope == "" || admission.ToolScope == "account-read" ||
			(admission.ToolScope == "public-only" && (request.Tool == "web_search" || request.Tool == "web_fetch"))
		if !allowed {
			writeAgentDSHToolError(c, "tool_scope_denied", "This request does not permit that tool. Answer from the permitted evidence; do not switch to a personal account or device.")
			return
		}
	}
	result, code, message := executeAgentDSHTool(c, request.Tool, request.Arguments)
	if code != "" {
		writeAgentDSHToolError(c, code, message)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{"version": 1, "result": result})
}

func executeAgentDSHTool(c *gin.Context, tool string, arguments map[string]any) (any, string, string) {
	switch tool {
	case "web_search":
		var args agentDSHToolSearchArgs
		if !decodeAgentDSHToolArgs(arguments, &args) {
			return nil, "invalid_arguments", "The search arguments are invalid."
		}
		query := strings.TrimSpace(args.Query)
		if query == "" || len([]rune(query)) > maxAgentSearchQuery {
			return nil, "invalid_arguments", "Search query must contain 1–200 characters."
		}
		limit := boundAgentDSHToolLimit(args.Limit, 5, agentDSHToolSearchMaxItems)
		provider, items, searchURL, err := searchAgentPublicSources(c.Request.Context(), query, limit)
		if err != nil {
			return nil, "search_unavailable", "Web search is temporarily unavailable."
		}
		if len(items) == 0 {
			return nil, "search_no_results", "No search results were retrieved. Do not repeat the same query. Explain the missing evidence or use a different relevant public source; do not invent sources."
		}
		return gin.H{"query": query, "provider": provider, "items": items, "search_url": searchURL}, "", ""
	case "web_fetch":
		return nil, "client_fetch_required", "Public page reading must run in the user's browser; this server does not fetch page contents."
	case "github_repositories":
		if !agentDSHGitHubConnected(c.GetInt("id")) {
			return nil, "github_not_connected", "Connect GitHub to use account repository tools."
		}
		var args agentDSHToolRepositoryArgs
		if !decodeAgentDSHToolArgs(arguments, &args) {
			return nil, "invalid_arguments", "The repository list arguments are invalid."
		}
		limit := boundAgentDSHToolLimit(args.Limit, 10, maxAgentGitHubItems)
		query := url.Values{}
		query.Set("affiliation", "owner,collaborator,organization_member")
		query.Set("sort", "updated")
		query.Set("per_page", strconv.Itoa(limit))
		var items []agentGitHubRepository
		if err := agentGitHubRequest(c, http.MethodGet, "https://api.github.com/user/repos?"+query.Encode(), nil, &items); err != nil {
			return nil, "github_request_failed", "GitHub repository list failed."
		}
		return gin.H{"items": items}, "", ""
	case "github_repositories_search":
		if !agentDSHGitHubConnected(c.GetInt("id")) {
			return nil, "github_not_connected", "Connect GitHub to use account repository tools."
		}
		var args agentDSHToolSearchArgs
		if !decodeAgentDSHToolArgs(arguments, &args) {
			return nil, "invalid_arguments", "The repository search arguments are invalid."
		}
		query := strings.TrimSpace(args.Query)
		if query == "" || len([]rune(query)) > maxAgentSearchQuery {
			return nil, "invalid_arguments", "Repository search query must contain 1–200 characters."
		}
		limit := boundAgentDSHToolLimit(args.Limit, 10, maxAgentGitHubItems)
		var result agentGitHubSearchResponse
		endpoint := "https://api.github.com/search/repositories?q=" + url.QueryEscape(query) + "&per_page=" + strconv.Itoa(limit)
		if err := agentGitHubRequest(c, http.MethodGet, endpoint, nil, &result); err != nil {
			return nil, "github_request_failed", "GitHub repository search failed."
		}
		return gin.H{"items": result.Items, "query": query}, "", ""
	case "github_content":
		if !agentDSHGitHubConnected(c.GetInt("id")) {
			return nil, "github_not_connected", "Connect GitHub in this website account to read repository files."
		}
		var args struct {
			Repo string `json:"repo"`
			Path string `json:"path"`
			Ref  string `json:"ref"`
		}
		if !decodeAgentDSHToolArgs(arguments, &args) || !service.ValidAgentRepositoryContentTarget(args.Repo, args.Path, args.Ref) {
			return nil, "invalid_arguments", "Provide owner/name, a repository-relative path, and an optional ref."
		}
		_, token, err := model.GetAgentGitHubCredential(c.GetInt("id"))
		if err != nil || token == "" {
			return nil, "github_not_connected", "GitHub authorization is unavailable for this account."
		}
		result, err := service.ReadAgentRepositoryContent(c.Request.Context(), args.Repo, args.Path, args.Ref, token)
		if err != nil {
			return nil, "github_content_unavailable", "The repository content could not be verified. No file content was confirmed."
		}
		return result, "", ""
	case "github_issue":
		if !agentDSHGitHubConnected(c.GetInt("id")) {
			return nil, "github_not_connected", "Connect GitHub to use account issue tools."
		}
		var args agentDSHToolIssueArgs
		if !decodeAgentDSHToolArgs(arguments, &args) {
			return nil, "invalid_arguments", "Provide owner/name and a positive issue number."
		}
		args.Repo = strings.TrimSpace(args.Repo)
		if !validAgentGitHubIssueTarget(args.Repo, args.Number) {
			return nil, "invalid_arguments", "Provide owner/name and a positive issue number."
		}
		result, err := readAgentGitHubIssue(c, args.Repo, args.Number)
		if err != nil {
			return nil, "github_request_failed", "GitHub issue read failed; no issue content was confirmed."
		}
		return result, "", ""
	case "github_issues_search":
		if !agentDSHGitHubConnected(c.GetInt("id")) {
			return nil, "github_not_connected", "Connect GitHub to search issues for this account."
		}
		var args agentDSHToolRepositoryArgs
		if !decodeAgentDSHToolArgs(arguments, &args) {
			return nil, "invalid_arguments", "The issue search arguments are invalid."
		}
		credential, _, err := model.GetAgentGitHubCredential(c.GetInt("id"))
		if err != nil || credential == nil || !agentGitHubLoginPattern.MatchString(strings.TrimSpace(credential.Login)) {
			return nil, "github_not_connected", "The connected GitHub account could not be verified."
		}
		login := strings.TrimSpace(credential.Login)
		limit := boundAgentDSHToolLimit(args.Limit, 10, maxAgentGitHubItems)
		query := url.Values{}
		query.Set("q", "user:"+login+" is:issue is:open")
		query.Set("sort", "updated")
		query.Set("order", "desc")
		query.Set("per_page", strconv.Itoa(limit))
		var result struct {
			TotalCount        int              `json:"total_count"`
			IncompleteResults bool             `json:"incomplete_results"`
			Items             []map[string]any `json:"items"`
		}
		if err := agentGitHubRequest(c, http.MethodGet, "https://api.github.com/search/issues?"+query.Encode(), nil, &result); err != nil {
			return nil, "github_request_failed", "GitHub issue search failed; no issue content was confirmed."
		}
		return gin.H{
			"login": login, "query": "user:" + login + " is:issue is:open",
			"total_count": result.TotalCount, "incomplete_results": result.IncompleteResults,
			"items": normalizeAgentGitHubActivity(result.Items, false),
		}, "", ""
	case "github_issues", "github_pull_requests":
		if !agentDSHGitHubConnected(c.GetInt("id")) {
			return nil, "github_not_connected", "Connect GitHub to use account repository tools."
		}
		var args agentDSHToolActivityArgs
		if !decodeAgentDSHToolArgs(arguments, &args) || !agentGitHubRepoPattern.MatchString(strings.TrimSpace(args.Repo)) {
			return nil, "invalid_arguments", "Repository must use owner/name form."
		}
		args.Repo = strings.TrimSpace(args.Repo)
		state := strings.TrimSpace(args.State)
		if state != "open" && state != "closed" && state != "all" {
			state = "open"
		}
		limit := boundAgentDSHToolLimit(args.Limit, 10, maxAgentGitHubItems)
		resource := "issues"
		if tool == "github_pull_requests" {
			resource = "pulls"
		}
		endpoint := fmt.Sprintf("https://api.github.com/repos/%s/%s?state=%s&per_page=%d&sort=updated&direction=desc", args.Repo, resource, url.QueryEscape(state), limit)
		var raw []map[string]any
		if err := agentGitHubRequest(c, http.MethodGet, endpoint, nil, &raw); err != nil {
			return nil, "github_request_failed", "GitHub activity request failed."
		}
		items := normalizeAgentGitHubActivity(raw, tool == "github_pull_requests")
		return gin.H{"repo": args.Repo, "items": items}, "", ""
	default:
		return nil, "tool_not_available", "This read-only tool is not available in this Lain42 runtime."
	}
}

func decodeAgentDSHToolArgs(arguments map[string]any, target any) bool {
	bytes, err := common.Marshal(arguments)
	if err != nil {
		return false
	}
	return common.Unmarshal(bytes, target) == nil
}

func boundAgentDSHToolLimit(value, fallback, maximum int) int {
	if value < 1 || value > maximum {
		return fallback
	}
	return value
}

func agentDSHGitHubConnected(userID int) bool {
	_, token, err := model.GetAgentGitHubCredential(userID)
	return err == nil && token != ""
}

func writeAgentDSHToolError(c *gin.Context, code, message string) {
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{"version": 1, "error": gin.H{"code": code, "message": message}})
}

var modelAgentDSHSessionIDPattern = regexp.MustCompile(`^[A-Za-z0-9]{64}$`)
