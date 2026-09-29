package controller

import (
	"crypto/rand"
	"crypto/sha256"
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
	agentDSHRequestIDPattern   = `^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`
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
	Model     string                  `json:"model,omitempty"`
	Mode      string                  `json:"mode,omitempty"`
	Text      string                  `json:"text"`
	Images    []dto.AgentDSHTurnImage `json:"images,omitempty"`
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
	wireRequest := agentDSHWireTurnRequest{
		Version:   version,
		SessionID: request.SessionID,
		RequestID: strings.ToLower(request.RequestID),
		Model:     request.Model,
		Mode:      mode,
		Text:      request.Text,
		Images:    request.Images,
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
	response, err := client.Do(outbound)
	if err != nil {
		writeAgentError(c, http.StatusBadGateway, "AGENT_DSH_TURN_FAILED", "The hosted Agent could not complete this turn")
		return
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		writeAgentError(c, http.StatusBadGateway, "AGENT_DSH_TURN_FAILED", "The hosted Agent could not complete this turn")
		return
	}
	responseBody, err := io.ReadAll(io.LimitReader(response.Body, agentDSHTurnResponseLimit+1))
	if err != nil || len(responseBody) > agentDSHTurnResponseLimit {
		writeAgentError(c, http.StatusBadGateway, "AGENT_DSH_INVALID_RESPONSE", "The hosted Agent returned an invalid response")
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
	if request.Model != "" && !agentDSHTurnModelName.MatchString(request.Model) {
		return false
	}
	return request.Mode == "" || request.Mode == "general" || request.Mode == "coding" || request.Mode == "research" || request.Mode == "content"
}

func configuredAgentDSHEndpoint(path string) (string, error) {
	raw := strings.TrimSpace(os.Getenv("LAIN42_DSH_BASE_URL"))
	parsed, err := url.Parse(raw)
	if err != nil || raw == "" || parsed == nil || parsed.User != nil || parsed.Host == "" || parsed.RawQuery != "" || parsed.Fragment != "" || (parsed.Path != "" && parsed.Path != "/") {
		return "", errors.New("invalid DSH base URL")
	}
	if parsed.Scheme != "https" && !(parsed.Scheme == "http" && isAgentDSHLoopback(parsed.Hostname())) {
		return "", errors.New("DSH must use HTTPS except on loopback")
	}
	return strings.TrimRight(parsed.String(), "/") + path, nil
}

func isAgentDSHLoopback(host string) bool {
	return strings.EqualFold(host, "localhost") || host == "127.0.0.1" || host == "::1" || host == "[::1]"
}

func signAgentDSHTurn(secret, timestamp, nonce string, body []byte) string {
	digest := sha256.Sum256(body)
	canonical := fmt.Sprintf("v1\n%s\n%s\nPOST\n%s\n%s", timestamp, nonce, agentDSHTurnPath, hex.EncodeToString(digest[:]))
	return common.GenerateHMACWithKey([]byte(secret), canonical)
}

type agentDSHToolSearchArgs struct {
	Query string `json:"query"`
	Limit int    `json:"limit"`
}

type agentDSHToolFetchArgs struct {
	URL string `json:"url"`
}

type agentDSHToolRepositoryArgs struct {
	Limit int `json:"limit"`
}

type agentDSHToolActivityArgs struct {
	Repo  string `json:"repo"`
	State string `json:"state"`
	Limit int    `json:"limit"`
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
	if err := common.Unmarshal(body, &request); err != nil || request.Version != 1 || request.Arguments == nil {
		writeAgentDSHToolError(c, "invalid_request", "The tool request is invalid")
		return
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
		provider := "bing"
		var items []agentWebSearchItem
		var err error
		searchEndpoint := strings.TrimSpace(os.Getenv("AGENT_WEB_SEARCH_URL"))
		if searchEndpoint == "" {
			items, err = searchBingRSS(c.Request.Context(), query, limit)
		} else {
			provider = "searxng"
			items, err = searchSearXNG(c.Request.Context(), searchEndpoint, query, limit)
		}
		if err != nil {
			return nil, "search_unavailable", "Web search is temporarily unavailable."
		}
		return gin.H{"query": query, "provider": provider, "items": items, "search_url": "https://www.bing.com/search?q=" + url.QueryEscape(query)}, "", ""
	case "web_fetch":
		var args agentDSHToolFetchArgs
		if !decodeAgentDSHToolArgs(arguments, &args) {
			return nil, "invalid_arguments", "The page URL is invalid."
		}
		pageURL, err := validateAgentFetchURL(args.URL)
		if err != nil {
			return nil, "invalid_arguments", "Only public HTTP(S) pages on the default port can be fetched."
		}
		result, err := fetchAgentWebPage(c.Request.Context(), pageURL)
		if err != nil {
			return nil, "fetch_unavailable", "The page could not be safely fetched as a supported text document."
		}
		return result, "", ""
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
		items := make([]agentGitHubActivity, 0, len(raw))
		for _, item := range raw {
			number, _ := item["number"].(float64)
			title, _ := item["title"].(string)
			htmlURL, _ := item["html_url"].(string)
			itemState, _ := item["state"].(string)
			updated, _ := item["updated_at"].(string)
			if title != "" && htmlURL != "" {
				items = append(items, agentGitHubActivity{Number: int(number), Title: title, URL: htmlURL, State: itemState, UpdatedAt: updated})
			}
		}
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
