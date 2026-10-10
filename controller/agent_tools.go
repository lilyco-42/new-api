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
	"unicode/utf8"

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

// AgentWebSearch provides bounded public search without account credentials.
// The result contract is shared with DSH and remains provider-independent.
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
	provider, items, searchURL, err := searchAgentPublicSources(c.Request.Context(), query, limit)
	if err != nil {
		writeAgentError(c, http.StatusBadGateway, "AGENT_SEARCH_UNAVAILABLE", "web search provider is unavailable or returned an invalid response")
		return
	}
	common.ApiSuccess(c, gin.H{
		"query":      query,
		"provider":   provider,
		"items":      items,
		"search_url": searchURL,
	})
}

// The browser endpoint and hosted tool share public-only provider selection.
// A configured search provider takes precedence. Otherwise explicit GitHub
// queries use its public repository index, without reading account credentials.
func searchAgentPublicSources(ctx context.Context, query string, limit int) (string, []agentWebSearchItem, string, error) {
	searchURL := "https://www.bing.com/search?q=" + url.QueryEscape(query)
	if endpoint := strings.TrimSpace(os.Getenv("AGENT_WEB_SEARCH_URL")); endpoint != "" {
		items, err := searchSearXNG(ctx, endpoint, query, limit)
		return "searxng", items, searchURL, err
	}
	if indexQuery := agentPublicGitHubQuery(query); indexQuery != "" {
		searchURL = "https://github.com/search?type=repositories&q=" + url.QueryEscape(indexQuery)
		values := url.Values{"q": {indexQuery}, "per_page": {strconv.Itoa(limit)}}
		body, err := fetchAgentSearchResponse(ctx, "https://api.github.com/search/repositories?"+values.Encode(), "application/vnd.github+json")
		if err != nil {
			return "github-public", nil, searchURL, err
		}
		items, err := parseAgentPublicGitHubSearch(body, limit)
		return "github-public", items, searchURL, err
	}
	items, err := searchBingRSS(ctx, query, limit)
	return "bing", items, searchURL, err
}

var agentPublicGitHubMarker = regexp.MustCompile(`(?i)(^|\s)(github|site:github\.com)(\s|$)`)

func agentPublicGitHubQuery(query string) string {
	if !agentPublicGitHubMarker.MatchString(query) {
		return ""
	}
	// Match the browser's removal of search boilerplate, while retaining GitHub
	// qualifiers, quoted terms, punctuation and repository owner/name tokens.
	terms := make([]string, 0)
	for _, term := range strings.Fields(query) {
		switch strings.ToLower(term) {
		case "a", "an", "and", "about", "find", "for", "github", "site:github.com", "how", "in", "official", "on", "project", "projects", "repo", "repos", "repositories", "repository", "search", "the", "to", "use", "官方", "仓库", "项目", "搜索", "查找":
			continue
		}
		terms = append(terms, term)
	}
	return strings.Join(terms, " ")
}

func parseAgentPublicGitHubSearch(body []byte, limit int) ([]agentWebSearchItem, error) {
	var payload struct {
		Incomplete bool `json:"incomplete_results"`
		Items      []struct {
			FullName    string `json:"full_name"`
			HTMLURL     string `json:"html_url"`
			Description string `json:"description"`
			Private     *bool  `json:"private"`
		} `json:"items"`
	}
	if err := common.Unmarshal(body, &payload); err != nil {
		return nil, err
	}
	if payload.Incomplete || payload.Items == nil {
		return nil, errors.New("public repository index returned incomplete or invalid results")
	}
	items := make([]agentWebSearchItem, 0, min(limit, len(payload.Items)))
	for _, repo := range payload.Items {
		if len(items) >= limit {
			break
		}
		if repo.Private == nil || *repo.Private || !agentGitHubRepoPattern.MatchString(repo.FullName) || repo.HTMLURL != "https://github.com/"+repo.FullName {
			continue
		}
		if item, ok := normalizeAgentSearchItem(repo.FullName, repo.HTMLURL, repo.Description); ok {
			items = append(items, item)
		}
	}
	return items, nil
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
	body, err := io.ReadAll(io.LimitReader(response.Body, 1<<20+1))
	if err != nil {
		return nil, err
	}
	if len(body) > 1<<20 {
		return nil, errors.New("web search response exceeds size limit")
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

type agentGitHubActivity struct {
	Number        int    `json:"number"`
	Repository    string `json:"repository,omitempty"`
	Title         string `json:"title"`
	URL           string `json:"url"`
	State         string `json:"state"`
	UpdatedAt     string `json:"updated_at,omitempty"`
	Body          string `json:"body,omitempty"`
	BodyTruncated bool   `json:"body_truncated,omitempty"`
}

// Share the bounded evidence contract between browser reads and hosted DSH tools.
func normalizeAgentGitHubActivity(raw []map[string]any, pulls bool) []agentGitHubActivity {
	items := make([]agentGitHubActivity, 0, len(raw))
	for _, item := range raw {
		if _, isPullRequest := item["pull_request"]; isPullRequest && !pulls {
			continue
		}
		number, _ := item["number"].(float64)
		title, _ := item["title"].(string)
		htmlURL, _ := item["html_url"].(string)
		itemState, _ := item["state"].(string)
		updated, _ := item["updated_at"].(string)
		body, _ := item["body"].(string)
		repositoryURL, _ := item["repository_url"].(string)
		truncated := len(body) > 4096
		if truncated {
			end := 4096
			for end > 0 && !utf8.RuneStart(body[end]) {
				end--
			}
			body = body[:end]
		}
		if title != "" && htmlURL != "" {
			items = append(items, agentGitHubActivity{Number: int(number), Repository: githubRepositoryNameFromAPIURL(repositoryURL), Title: title, URL: htmlURL, State: itemState, UpdatedAt: updated, Body: body, BodyTruncated: truncated})
		}
	}
	return items
}

func githubRepositoryNameFromAPIURL(raw string) string {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "https" || parsed.Hostname() != "api.github.com" {
		return ""
	}
	parts := strings.Split(strings.Trim(parsed.Path, "/"), "/")
	if len(parts) != 3 || parts[0] != "repos" || !agentGitHubRepoPattern.MatchString(parts[1]+"/"+parts[2]) {
		return ""
	}
	return parts[1] + "/" + parts[2]
}

var (
	agentGitHubRepoPattern  = regexp.MustCompile(`^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`)
	agentGitHubLoginPattern = regexp.MustCompile(`^[A-Za-z0-9-]+$`)
)

func AgentGitHubRepositoriesList(c *gin.Context) {
	limit := parseBoundedAgentInt(c.Query("limit"), 10, 1, maxAgentGitHubItems)
	query := url.Values{}
	query.Set("affiliation", "owner,collaborator,organization_member")
	query.Set("sort", "updated")
	query.Set("per_page", strconv.Itoa(limit))
	endpoint := "https://api.github.com/user/repos?" + query.Encode()
	var items []agentGitHubRepository
	if err := agentGitHubRequest(c, http.MethodGet, endpoint, nil, &items); err != nil {
		writeAgentError(c, http.StatusBadGateway, "AGENT_GITHUB_REQUEST_FAILED", "GitHub repository list failed")
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
		writeAgentError(c, http.StatusBadGateway, "AGENT_GITHUB_REQUEST_FAILED", "GitHub repository search failed")
		return
	}
	common.ApiSuccess(c, gin.H{"items": result.Items, "query": query})
}

func AgentGitHubIssues(c *gin.Context)       { agentGitHubActivityList(c, false) }
func AgentGitHubPullRequests(c *gin.Context) { agentGitHubActivityList(c, true) }

// AgentGitHubIssuesSearch reads the connected account's most recently updated
// open issues across repositories it owns. The account identity comes only
// from the credential attached to the authenticated New API user.
func AgentGitHubIssuesSearch(c *gin.Context) {
	credential, _, err := model.GetAgentGitHubCredential(c.GetInt("id"))
	if errors.Is(err, gorm.ErrRecordNotFound) || credential == nil {
		writeAgentError(c, http.StatusUnauthorized, "AGENT_GITHUB_NOT_CONNECTED", "GitHub is not connected for this account")
		return
	}
	if err != nil {
		writeAgentError(c, http.StatusInternalServerError, "AGENT_GITHUB_STATUS_FAILED", "GitHub authorization status is unavailable")
		return
	}
	login := strings.TrimSpace(credential.Login)
	if login == "" || !agentGitHubLoginPattern.MatchString(login) {
		writeAgentError(c, http.StatusUnauthorized, "AGENT_GITHUB_NOT_CONNECTED", "The connected GitHub account could not be verified")
		return
	}
	limit := parseBoundedAgentInt(c.Query("limit"), 10, 1, maxAgentGitHubItems)
	query := url.Values{}
	query.Set("q", "user:"+login+" is:issue is:open")
	query.Set("sort", "updated")
	query.Set("order", "desc")
	query.Set("per_page", strconv.Itoa(limit))
	endpoint := "https://api.github.com/search/issues?" + query.Encode()
	var result struct {
		TotalCount        int              `json:"total_count"`
		IncompleteResults bool             `json:"incomplete_results"`
		Items             []map[string]any `json:"items"`
	}
	if err := agentGitHubRequest(c, http.MethodGet, endpoint, nil, &result); err != nil {
		writeAgentError(c, http.StatusBadGateway, "AGENT_GITHUB_REQUEST_FAILED", "GitHub issue search failed")
		return
	}
	common.ApiSuccess(c, gin.H{
		"login":              login,
		"query":              "user:" + login + " is:issue is:open",
		"total_count":        result.TotalCount,
		"incomplete_results": result.IncompleteResults,
		"items":              normalizeAgentGitHubActivity(result.Items, false),
	})
}

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
		writeAgentError(c, http.StatusBadGateway, "AGENT_GITHUB_REQUEST_FAILED", "GitHub activity request failed")
		return
	}
	items := normalizeAgentGitHubActivity(raw, pulls)
	common.ApiSuccess(c, gin.H{"repo": repo, "items": items})
}

type agentGitHubHTTPError struct{ StatusCode int }

func (err *agentGitHubHTTPError) Error() string {
	return fmt.Sprintf("github returned status %d", err.StatusCode)
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
		return &agentGitHubHTTPError{StatusCode: response.StatusCode}
	}
	return common.DecodeJson(io.LimitReader(response.Body, 2<<20), output)
}

func parseBoundedAgentInt(raw string, fallback, min, max int) int {
	value, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil || value < min || value > max {
		return fallback
	}
	return value
}
