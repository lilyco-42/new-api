package controller

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
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

type duckDuckGoResponse struct {
	AbstractText string `json:"AbstractText"`
	AbstractURL  string `json:"AbstractURL"`
	Heading      string `json:"Heading"`
	Related      []struct {
		Text     string `json:"Text"`
		FirstURL string `json:"FirstURL"`
		Topics   []struct {
			Text     string `json:"Text"`
			FirstURL string `json:"FirstURL"`
		} `json:"Topics"`
	} `json:"RelatedTopics"`
}

// AgentWebSearch provides a keyless, server-side web lookup for the Agent.
// The provider is deliberately isolated behind this endpoint so a Brave,
// Bing, or self-hosted search backend can be added without changing clients.
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
	endpoint := "https://api.duckduckgo.com/?q=" + url.QueryEscape(query) + "&format=json&no_html=1&skip_disambig=1"
	request, err := http.NewRequestWithContext(c.Request.Context(), http.MethodGet, endpoint, nil)
	if err != nil {
		writeAgentError(c, http.StatusBadGateway, "AGENT_SEARCH_UNAVAILABLE", "web search is unavailable")
		return
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("User-Agent", "Lain42-Agent/1.0 (+https://lain42.top/agent)")
	client := &http.Client{Timeout: 8 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		writeAgentError(c, http.StatusBadGateway, "AGENT_SEARCH_UNAVAILABLE", "web search is unavailable")
		return
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		writeAgentError(c, http.StatusBadGateway, "AGENT_SEARCH_UNAVAILABLE", "web search provider returned an error")
		return
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		writeAgentError(c, http.StatusBadGateway, "AGENT_SEARCH_UNAVAILABLE", "web search response could not be read")
		return
	}
	var payload duckDuckGoResponse
	if err := json.Unmarshal(body, &payload); err != nil {
		writeAgentError(c, http.StatusBadGateway, "AGENT_SEARCH_UNAVAILABLE", "web search response was invalid")
		return
	}
	items := make([]agentWebSearchItem, 0, limit)
	if payload.AbstractURL != "" && payload.AbstractText != "" {
		items = append(items, agentWebSearchItem{Title: firstNonEmpty(payload.Heading, query), URL: payload.AbstractURL, Snippet: payload.AbstractText, Source: "DuckDuckGo"})
	}
	for _, related := range payload.Related {
		if len(items) >= limit {
			break
		}
		if related.FirstURL != "" && related.Text != "" {
			items = append(items, agentWebSearchItem{Title: related.Text, URL: related.FirstURL, Snippet: related.Text, Source: "DuckDuckGo"})
		}
		for _, nested := range related.Topics {
			if len(items) >= limit {
				break
			}
			if nested.FirstURL != "" && nested.Text != "" {
				items = append(items, agentWebSearchItem{Title: nested.Text, URL: nested.FirstURL, Snippet: nested.Text, Source: "DuckDuckGo"})
			}
		}
	}
	common.ApiSuccess(c, gin.H{
		"query":      query,
		"provider":   "duckduckgo",
		"items":      items,
		"search_url": "https://duckduckgo.com/?q=" + url.QueryEscape(query),
	})
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
}

type agentGitHubSearchResponse struct {
	Items []agentGitHubRepository `json:"items"`
}

type agentGitHubActivity struct {
	Number    int    `json:"number"`
	Title     string `json:"title"`
	URL       string `json:"url"`
	State     string `json:"state"`
	UpdatedAt string `json:"updated_at,omitempty"`
}

var agentGitHubRepoPattern = regexp.MustCompile(`^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`)

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
		return fmt.Errorf("github returned status %d", response.StatusCode)
	}
	return json.NewDecoder(io.LimitReader(response.Body, 2<<20)).Decode(output)
}

func parseBoundedAgentInt(raw string, fallback, min, max int) int {
	value, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil || value < min || value > max {
		return fallback
	}
	return value
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return "Search result"
}
