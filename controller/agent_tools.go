package controller

import (
	"context"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	stdhtml "html"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

const (
	maxAgentSearchQuery = 200
	maxAgentSearchItems = 8
	maxAgentGitHubItems = 20
)

type agentWebSearchItem struct {
	Title   string `json:"title"`
	URL     string `json:"url"`
	Snippet string `json:"snippet,omitempty"`
	Source  string `json:"source"`
}

type bingSearchRSS struct {
	Channel struct {
		Items []struct {
			Title       string `xml:"title"`
			Link        string `xml:"link"`
			Description string `xml:"description"`
		} `xml:"item"`
	} `xml:"channel"`
}

var agentSearchHTMLTag = regexp.MustCompile(`<[^>]*>`)

// AgentWebSearch provides a bounded web search for the Agent. Bing's RSS
// response is used because it returns ordinary result links without requiring
// an API key; the client-facing contract remains provider-independent.
func AgentWebSearch(c *gin.Context) {
	query := strings.TrimSpace(c.Query("q"))
	if query == "" {
		query = strings.TrimSpace(c.Query("query"))
	}
	if query == "" || len([]rune(query)) > maxAgentSearchQuery {
		writeAgentError(c, http.StatusBadRequest, "AGENT_SEARCH_INVALID", "search query must contain 1–200 characters")
		return
	}
	limit := parseBoundedAgentInt(c.Query("limit"), 5, 1, maxAgentSearchItems)
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
		writeAgentError(c, http.StatusBadGateway, "AGENT_SEARCH_UNAVAILABLE", "web search provider is unavailable or returned an invalid response")
		return
	}
	searchURL := "https://www.bing.com/search?q=" + url.QueryEscape(query)
	common.ApiSuccess(c, gin.H{
		"query":      query,
		"provider":   provider,
		"items":      items,
		"search_url": searchURL,
	})
}

func searchBingRSS(ctx context.Context, query string, limit int) ([]agentWebSearchItem, error) {
	endpoint := "https://www.bing.com/search?format=rss&q=" + url.QueryEscape(query)
	body, err := fetchAgentSearchResponse(ctx, endpoint, "application/rss+xml, application/xml, text/xml", "cn.bing.com")
	if err != nil {
		return nil, err
	}
	return parseBingSearchRSS(body, limit)
}

func searchSearXNG(ctx context.Context, configuredEndpoint, query string, limit int) ([]agentWebSearchItem, error) {
	endpoint, err := url.Parse(strings.TrimSpace(configuredEndpoint))
	if err != nil || (endpoint.Scheme != "https" && endpoint.Scheme != "http") || endpoint.Host == "" || endpoint.User != nil || endpoint.Fragment != "" {
		return nil, errors.New("invalid configured web search endpoint")
	}
	queryValues := endpoint.Query()
	queryValues.Set("q", query)
	queryValues.Set("format", "json")
	endpoint.RawQuery = queryValues.Encode()
	body, err := fetchAgentSearchResponse(ctx, endpoint.String(), "application/json")
	if err != nil {
		return nil, err
	}
	return parseSearXNGSearchJSON(body, limit)
}

func fetchAgentSearchResponse(ctx context.Context, endpoint, accept string, allowedRedirectHosts ...string) ([]byte, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Accept", accept)
	request.Header.Set("User-Agent", "Lain42-Agent/1.0 (+https://lain42.top/agent)")
	originHost := request.URL.Host
	originScheme := request.URL.Scheme
	client := &http.Client{
		Timeout: 8 * time.Second,
		CheckRedirect: func(next *http.Request, previous []*http.Request) error {
			hostAllowed := strings.EqualFold(next.URL.Host, originHost)
			for _, allowedHost := range allowedRedirectHosts {
				hostAllowed = hostAllowed || strings.EqualFold(next.URL.Host, allowedHost)
			}
			if len(previous) >= 2 || !hostAllowed || next.URL.Scheme != originScheme {
				return http.ErrUseLastResponse
			}
			return nil
		},
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return nil, fmt.Errorf("web search provider returned status %d", response.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	return body, nil
}

func parseBingSearchRSS(body []byte, limit int) ([]agentWebSearchItem, error) {
	var feed bingSearchRSS
	if err := xml.Unmarshal(body, &feed); err != nil {
		return nil, err
	}
	items := make([]agentWebSearchItem, 0, min(limit, len(feed.Channel.Items)))
	for _, result := range feed.Channel.Items {
		if len(items) >= limit {
			break
		}
		if item, ok := normalizeAgentSearchItem(result.Title, result.Link, result.Description); ok {
			items = append(items, item)
		}
	}
	return items, nil
}

func parseSearXNGSearchJSON(body []byte, limit int) ([]agentWebSearchItem, error) {
	var payload struct {
		Results []struct {
			Title   string `json:"title"`
			URL     string `json:"url"`
			Content string `json:"content"`
		} `json:"results"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, err
	}
	items := make([]agentWebSearchItem, 0, min(limit, len(payload.Results)))
	for _, result := range payload.Results {
		if len(items) >= limit {
			break
		}
		if item, ok := normalizeAgentSearchItem(result.Title, result.URL, result.Content); ok {
			items = append(items, item)
		}
	}
	return items, nil
}

func normalizeAgentSearchItem(title, rawURL, snippet string) (agentWebSearchItem, bool) {
	parsedURL, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || (parsedURL.Scheme != "https" && parsedURL.Scheme != "http") || parsedURL.Hostname() == "" {
		return agentWebSearchItem{}, false
	}
	title = cleanAgentSearchText(title, 180)
	if title == "" {
		return agentWebSearchItem{}, false
	}
	return agentWebSearchItem{
		Title:   title,
		URL:     parsedURL.String(),
		Snippet: cleanAgentSearchText(snippet, 500),
		Source:  parsedURL.Hostname(),
	}, true
}

func cleanAgentSearchText(value string, maxRunes int) string {
	plain := stdhtml.UnescapeString(agentSearchHTMLTag.ReplaceAllString(value, " "))
	plain = strings.Join(strings.Fields(plain), " ")
	runes := []rune(plain)
	if len(runes) > maxRunes {
		plain = string(runes[:maxRunes]) + "…"
	}
	return plain
}

type agentGitHubStatus struct {
	Enabled   bool     `json:"enabled"`
	Connected bool     `json:"connected"`
	Login     string   `json:"login,omitempty"`
	Scope     []string `json:"scope,omitempty"`
	ClientID  string   `json:"client_id,omitempty"`
}

func AgentGitHubStatus(c *gin.Context) {
	credential, _, err := model.GetAgentGitHubCredential(c.GetInt("id"))
	status := agentGitHubStatus{Enabled: common.GitHubOAuthEnabled && common.GitHubClientId != "" && common.GitHubClientSecret != "", ClientID: common.GitHubClientId}
	if err == nil && credential != nil {
		status.Connected = true
		status.Login = credential.Login
		status.Scope = strings.Fields(credential.Scope)
	} else if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
		writeAgentError(c, http.StatusInternalServerError, "AGENT_GITHUB_STATUS_FAILED", "GitHub authorization status is unavailable")
		return
	}
	common.ApiSuccess(c, status)
}

func AgentGitHubDisconnect(c *gin.Context) {
	if err := model.DeleteAgentGitHubCredential(c.GetInt("id")); err != nil {
		writeAgentError(c, http.StatusInternalServerError, "AGENT_GITHUB_DISCONNECT_FAILED", "GitHub authorization could not be removed")
		return
	}
	common.ApiSuccess(c, gin.H{"connected": false})
}

type agentGitHubRepository struct {
	FullName      string `json:"full_name"`
	HTMLURL       string `json:"html_url"`
	Description   string `json:"description,omitempty"`
	Stars         int    `json:"stargazers_count"`
	DefaultBranch string `json:"default_branch,omitempty"`
	Private       bool   `json:"private,omitempty"`
	UpdatedAt     string `json:"updated_at,omitempty"`
}

type agentGitHubSearchResponse struct {
	Items []agentGitHubRepository `json:"items"`
}

type agentGitHubUpstreamStatusError struct {
	statusCode int
}

func (err *agentGitHubUpstreamStatusError) Error() string {
	return fmt.Sprintf("GitHub returned status %d", err.statusCode)
}

type agentGitHubActivity struct {
	Number    int    `json:"number"`
	Title     string `json:"title"`
	URL       string `json:"url"`
	State     string `json:"state"`
	UpdatedAt string `json:"updated_at,omitempty"`
}

var agentGitHubRepoPattern = regexp.MustCompile(`^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`)

func AgentGitHubRepositoriesList(c *gin.Context) {
	limit := parseBoundedAgentInt(c.Query("limit"), 10, 1, maxAgentGitHubItems)
	query := url.Values{}
	query.Set("affiliation", "owner,collaborator,organization_member")
	query.Set("sort", "updated")
	query.Set("per_page", strconv.Itoa(limit))
	endpoint := "https://api.github.com/user/repos?" + query.Encode()
	var items []agentGitHubRepository
	if err := agentGitHubRequest(c, http.MethodGet, endpoint, nil, &items); err != nil {
		writeAgentGitHubRequestError(c, "repository list", err)
		return
	}
	common.ApiSuccess(c, gin.H{"items": items})
}

func AgentGitHubRepositoriesSearch(c *gin.Context) {
	query := strings.TrimSpace(c.Query("q"))
	if query == "" {
		query = strings.TrimSpace(c.Query("query"))
	}
	if query == "" || len([]rune(query)) > maxAgentSearchQuery {
		writeAgentError(c, http.StatusBadRequest, "AGENT_GITHUB_INVALID", "repository search query must contain 1–200 characters")
		return
	}
	limit := parseBoundedAgentInt(c.Query("limit"), 10, 1, maxAgentGitHubItems)
	var queryURL = "https://api.github.com/search/repositories?q=" + url.QueryEscape(query) + "&per_page=" + strconv.Itoa(limit)
	var result agentGitHubSearchResponse
	if err := agentGitHubRequest(c, http.MethodGet, queryURL, nil, &result); err != nil {
		writeAgentGitHubRequestError(c, "repository search", err)
		return
	}
	common.ApiSuccess(c, gin.H{"items": result.Items, "query": query})
}

func AgentGitHubIssues(c *gin.Context)       { agentGitHubActivityList(c, false) }
func AgentGitHubPullRequests(c *gin.Context) { agentGitHubActivityList(c, true) }

func agentGitHubActivityList(c *gin.Context, pulls bool) {
	repo := strings.TrimSpace(c.Query("repo"))
	if !agentGitHubRepoPattern.MatchString(repo) {
		writeAgentError(c, http.StatusBadRequest, "AGENT_GITHUB_INVALID", "repository must use owner/name form")
		return
	}
	limit := parseBoundedAgentInt(c.Query("limit"), 10, 1, maxAgentGitHubItems)
	state := strings.TrimSpace(c.Query("state"))
	if state != "open" && state != "closed" && state != "all" {
		state = "open"
	}
	resource := "issues"
	if pulls {
		resource = "pulls"
	}
	endpoint := fmt.Sprintf("https://api.github.com/repos/%s/%s?state=%s&per_page=%d&sort=updated&direction=desc", repo, resource, url.QueryEscape(state), limit)
	var raw []map[string]any
	if err := agentGitHubRequest(c, http.MethodGet, endpoint, nil, &raw); err != nil {
		action := "issue list"
		if pulls {
			action = "pull request list"
		}
		writeAgentGitHubRequestError(c, action, err)
		return
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
	common.ApiSuccess(c, gin.H{"repo": repo, "items": items})
}

func agentGitHubRequest(c *gin.Context, method, endpoint string, body io.Reader, output any) error {
	request, err := http.NewRequestWithContext(c.Request.Context(), method, endpoint, body)
	if err != nil {
		return err
	}
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	request.Header.Set("User-Agent", "Lain42-Agent/1.0 (+https://lain42.top/agent)")
	if _, token, tokenErr := model.GetAgentGitHubCredential(c.GetInt("id")); tokenErr == nil && token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	response, err := (&http.Client{Timeout: 12 * time.Second}).Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return &agentGitHubUpstreamStatusError{statusCode: response.StatusCode}
	}
	return common.DecodeJson(io.LimitReader(response.Body, 2<<20), output)
}

func writeAgentGitHubRequestError(c *gin.Context, action string, err error) {
	message := fmt.Sprintf("GitHub %s failed before the service could read a usable response. Retry later.", action)
	var upstreamError *agentGitHubUpstreamStatusError
	if errors.As(err, &upstreamError) {
		switch upstreamError.statusCode {
		case http.StatusUnauthorized:
			message = fmt.Sprintf("GitHub %s failed: GitHub rejected this site's OAuth authorization (HTTP 401). Reconnect GitHub on this site and retry; local gh CLI sign-in is unrelated.", action)
		case http.StatusForbidden:
			message = fmt.Sprintf("GitHub %s failed: GitHub denied access (HTTP 403). Check this site's repository authorization or retry after the upstream rate limit clears.", action)
		case http.StatusNotFound:
			message = fmt.Sprintf("GitHub %s failed: the resource was not found or is not visible to this account (HTTP 404).", action)
		case http.StatusTooManyRequests:
			message = fmt.Sprintf("GitHub %s failed: GitHub rate-limited the request (HTTP 429). Retry later.", action)
		default:
			message = fmt.Sprintf("GitHub %s failed with upstream HTTP %d. Retry later.", action, upstreamError.statusCode)
		}
	}
	writeAgentError(c, http.StatusBadGateway, "AGENT_GITHUB_REQUEST_FAILED", message)
}

func parseBoundedAgentInt(raw string, fallback, min, max int) int {
	value, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil || value < min || value > max {
		return fallback
	}
	return value
}
