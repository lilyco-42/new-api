package controller

import (
	"context"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

const agentToolRelayResponseVersion = 1

type agentToolRelayRequest struct {
	Version   int            `json:"version"`
	SessionID string         `json:"session_id"`
	Tool      string         `json:"tool"`
	Arguments map[string]any `json:"arguments"`
}

type agentToolRelayFault struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// AgentDSHToolRelay is a private DSH-to-New-API capability endpoint. HMAC
// authentication happens before the DSH session is resolved to its account;
// neither a browser-supplied user id nor a GitHub token crosses this boundary.
func AgentDSHToolRelay(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	mediaType, _, mediaErr := mime.ParseMediaType(c.GetHeader("Content-Type"))
	if mediaErr != nil || !strings.EqualFold(mediaType, "application/json") {
		c.JSON(http.StatusUnsupportedMediaType, gin.H{"error": "content_type_required"})
		return
	}
	body, err := io.ReadAll(io.LimitReader(c.Request.Body, service.AgentDSHToolRelayMaxBody+1))
	if err != nil || len(body) == 0 || len(body) > service.AgentDSHToolRelayMaxBody {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid_request"})
		return
	}
	if err := service.AuthenticateAgentToolRelayRequest(
		body,
		c.GetHeader("X-Lain42-Timestamp"),
		c.GetHeader("X-Lain42-Nonce"),
		c.GetHeader("X-Lain42-Signature"),
	); err != nil {
		if errors.Is(err, service.ErrAgentToolRelayDisabled) {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "tool_relay_unavailable"})
			return
		}
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}
	var fields map[string]any
	if err := common.Unmarshal(body, &fields); err != nil || len(fields) != 4 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid_request"})
		return
	}
	for key := range fields {
		if key != "version" && key != "session_id" && key != "tool" && key != "arguments" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid_request"})
			return
		}
	}
	var request agentToolRelayRequest
	if err := common.Unmarshal(body, &request); err != nil || request.Version != 1 || request.Arguments == nil || len(request.Arguments) > 8 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid_request"})
		return
	}
	session, err := model.ResolveAgentWebSessionForRelay(request.SessionID)
	if errors.Is(err, gorm.ErrRecordNotFound) || errors.Is(err, model.ErrAgentWebSessionInvalid) {
		c.JSON(http.StatusNotFound, gin.H{"error": "session_not_found"})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "session_unavailable"})
		return
	}
	result, fault := executeAgentToolRelay(c, session.UserId, request.Tool, request.Arguments)
	if fault != nil {
		c.JSON(http.StatusOK, gin.H{"version": agentToolRelayResponseVersion, "error": fault})
		return
	}
	c.JSON(http.StatusOK, gin.H{"version": agentToolRelayResponseVersion, "result": result})
}

func executeAgentToolRelay(c *gin.Context, userID int, tool string, args map[string]any) (any, *agentToolRelayFault) {
	ctx := c.Request.Context()
	switch tool {
	case "web_search":
		query, ok := relayString(args, "query")
		if !ok || query == "" || len([]rune(query)) > maxAgentSearchQuery || !relayOnlyKeys(args, "query", "limit") {
			return nil, relayFault("invalid_arguments", "Search needs a query of 1–200 characters.")
		}
		limit, ok := relayLimit(args, 5, maxAgentSearchItems)
		if !ok {
			return nil, relayFault("invalid_arguments", "Search limit must be between 1 and 8.")
		}
		result, err := searchAgentWeb(ctx, query, limit)
		if err != nil {
			return nil, relayFault("search_unavailable", "Web search is temporarily unavailable. Retry or paste a public page URL.")
		}
		return result, nil
	case "web_fetch":
		rawURL, ok := relayString(args, "url")
		if !ok || !relayOnlyKeys(args, "url") {
			return nil, relayFault("invalid_arguments", "Provide one public HTTP or HTTPS page URL.")
		}
		pageURL, err := validateAgentFetchURL(rawURL)
		if err != nil {
			return nil, relayFault("url_not_allowed", "Only public HTTP or HTTPS pages on the default port can be read.")
		}
		result, err := fetchAgentWebPage(ctx, pageURL)
		if err != nil {
			return nil, relayFault("page_unavailable", "The public page could not be safely read. It may block automated requests or contain an unsupported format.")
		}
		return result, nil
	case "github_repositories", "github_repositories_search", "github_issues", "github_pull_requests":
		credentialState := agentToolRelayGitHubCredentialState(userID)
		if credentialState != nil {
			return nil, credentialState
		}
		return executeAgentGitHubToolRelay(ctx, userID, tool, args)
	default:
		return nil, relayFault("unknown_tool", "This read-only tool is not available.")
	}
}

func agentToolRelayGitHubCredentialState(userID int) *agentToolRelayFault {
	credential, token, err := model.GetAgentGitHubCredential(userID)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return relayFault("github_not_connected", "Connect GitHub in this website account first. Local gh CLI sign-in is not used by browser chats.")
	}
	if err != nil {
		return relayFault("github_unavailable", "GitHub authorization could not be checked. Retry later.")
	}
	if credential == nil || token == "" {
		return relayFault("github_not_connected", "Connect GitHub in this website account first. Local gh CLI sign-in is not used by browser chats.")
	}
	return nil
}

func executeAgentGitHubToolRelay(ctx context.Context, userID int, tool string, args map[string]any) (any, *agentToolRelayFault) {
	switch tool {
	case "github_repositories":
		if !relayOnlyKeys(args, "limit") {
			return nil, relayFault("invalid_arguments", "Repository list accepts only a result limit.")
		}
		limit, ok := relayLimit(args, 10, maxAgentGitHubItems)
		if !ok {
			return nil, relayFault("invalid_arguments", "Result limit must be between 1 and 20.")
		}
		query := url.Values{}
		query.Set("affiliation", "owner,collaborator,organization_member")
		query.Set("sort", "updated")
		query.Set("per_page", fmt.Sprint(limit))
		var items []agentGitHubRepository
		if err := agentGitHubRequestForUser(ctx, userID, http.MethodGet, "https://api.github.com/user/repos?"+query.Encode(), nil, &items); err != nil {
			return nil, relayFault("github_request_failed", githubRelayFailureMessage(err))
		}
		return gin.H{"items": items}, nil
	case "github_repositories_search":
		query, ok := relayString(args, "query")
		if !ok || query == "" || len([]rune(query)) > maxAgentSearchQuery || !relayOnlyKeys(args, "query", "limit") {
			return nil, relayFault("invalid_arguments", "Repository search needs a query of 1–200 characters.")
		}
		limit, ok := relayLimit(args, 10, maxAgentGitHubItems)
		if !ok {
			return nil, relayFault("invalid_arguments", "Result limit must be between 1 and 20.")
		}
		endpoint := "https://api.github.com/search/repositories?q=" + url.QueryEscape(query) + "&per_page=" + fmt.Sprint(limit)
		var result agentGitHubSearchResponse
		if err := agentGitHubRequestForUser(ctx, userID, http.MethodGet, endpoint, nil, &result); err != nil {
			return nil, relayFault("github_request_failed", githubRelayFailureMessage(err))
		}
		return gin.H{"items": result.Items, "query": query}, nil
	case "github_issues", "github_pull_requests":
		repo, ok := relayString(args, "repo")
		if !ok || !isValidAgentGitHubRepo(repo) || !relayOnlyKeys(args, "repo", "state", "limit") {
			return nil, relayFault("invalid_arguments", "Provide a repository in owner/name form.")
		}
		state := "open"
		if value, exists := args["state"]; exists {
			var valid bool
			state, valid = value.(string)
			state = strings.TrimSpace(state)
			if !valid {
				return nil, relayFault("invalid_arguments", "State must be open, closed, or all.")
			}
		} else {
			state = "open"
		}
		if state != "open" && state != "closed" && state != "all" {
			return nil, relayFault("invalid_arguments", "State must be open, closed, or all.")
		}
		limit, ok := relayLimit(args, 10, maxAgentGitHubItems)
		if !ok {
			return nil, relayFault("invalid_arguments", "Result limit must be between 1 and 20.")
		}
		resource := "issues"
		if tool == "github_pull_requests" {
			resource = "pulls"
		}
		endpoint := fmt.Sprintf("https://api.github.com/repos/%s/%s?state=%s&per_page=%d&sort=updated&direction=desc", repo, resource, url.QueryEscape(state), limit)
		var raw []map[string]any
		if err := agentGitHubRequestForUser(ctx, userID, http.MethodGet, endpoint, nil, &raw); err != nil {
			return nil, relayFault("github_request_failed", githubRelayFailureMessage(err))
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
		return gin.H{"repo": repo, "items": items}, nil
	default:
		return nil, relayFault("unknown_tool", "This GitHub read-only tool is not available.")
	}
}

func githubRelayFailureMessage(err error) string {
	var upstreamError *agentGitHubUpstreamStatusError
	if !errors.As(err, &upstreamError) {
		return "GitHub could not be reached. Retry later."
	}
	switch upstreamError.statusCode {
	case http.StatusUnauthorized:
		return "GitHub rejected this website authorization. Reconnect GitHub on this site and retry."
	case http.StatusForbidden, http.StatusTooManyRequests:
		return "GitHub denied or rate-limited this request. Check repository access or retry later."
	case http.StatusNotFound:
		return "The GitHub repository or resource was not found or is not visible to this account."
	default:
		return fmt.Sprintf("GitHub returned HTTP %d. Retry later.", upstreamError.statusCode)
	}
}

func relayFault(code, message string) *agentToolRelayFault {
	return &agentToolRelayFault{Code: code, Message: message}
}

func relayString(args map[string]any, key string) (string, bool) {
	value, ok := args[key].(string)
	value = strings.TrimSpace(value)
	return value, ok
}

func relayLimit(args map[string]any, fallback, maximum int) (int, bool) {
	value, exists := args["limit"]
	if !exists {
		return fallback, true
	}
	number, ok := value.(float64)
	if !ok || number < 1 || number > float64(maximum) || number != float64(int(number)) {
		return 0, false
	}
	return int(number), true
}

func relayOnlyKeys(args map[string]any, allowed ...string) bool {
	allowedSet := make(map[string]struct{}, len(allowed))
	for _, key := range allowed {
		allowedSet[key] = struct{}{}
	}
	for key := range args {
		if _, ok := allowedSet[key]; !ok {
			return false
		}
	}
	return true
}
