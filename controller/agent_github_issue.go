package controller

import (
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

type agentGitHubIssueComment struct {
	Body          string `json:"body"`
	BodyTruncated bool   `json:"body_truncated,omitempty"`
	URL           string `json:"url"`
	Author        string `json:"author"`
}

type agentGitHubIssueResult struct {
	Repo              string                    `json:"repo"`
	Items             []agentGitHubActivity     `json:"items"`
	Comments          []agentGitHubIssueComment `json:"comments"`
	CommentsOrder     string                    `json:"comments_order"`
	CommentsTruncated bool                      `json:"comments_truncated"`
	CommentsError     string                    `json:"comments_error"`
}

func validAgentGitHubIssueTarget(repo string, number int) bool {
	parts := strings.Split(repo, "/")
	return number > 0 && number <= 2147483647 && agentGitHubRepoPattern.MatchString(repo) &&
		len(parts) == 2 && agentGitHubLoginPattern.MatchString(parts[0]) && parts[1] != "." && parts[1] != ".."
}

// boundedAgentGitHubText keeps the byte limit without splitting a UTF-8 character.
func boundedAgentGitHubText(text string, limit int) (string, bool) {
	if len(text) <= limit {
		return text, false
	}
	end := limit
	for end > 0 && !utf8.RuneStart(text[end]) {
		end--
	}
	return text[:end], true
}

// AgentGitHubIssueRead reads one explicitly identified issue, including closed
// issues, with at most three oldest comments. All content uses this account's OAuth grant.
func AgentGitHubIssueRead(c *gin.Context) {
	repo := strings.TrimSpace(c.Query("repo"))
	number, err := strconv.Atoi(c.Query("number"))
	if err != nil || !validAgentGitHubIssueTarget(repo, number) {
		writeAgentError(c, http.StatusBadRequest, "AGENT_GITHUB_INVALID", "provide owner/name and a positive issue number")
		return
	}
	credential, _, err := model.GetAgentGitHubCredential(c.GetInt("id"))
	if errors.Is(err, gorm.ErrRecordNotFound) || (err == nil && credential == nil) {
		writeAgentError(c, http.StatusUnauthorized, "AGENT_GITHUB_NOT_CONNECTED", "GitHub is not connected for this account")
		return
	}
	if err != nil {
		writeAgentError(c, http.StatusInternalServerError, "AGENT_GITHUB_STATUS_FAILED", "GitHub authorization status is unavailable")
		return
	}
	result, err := readAgentGitHubIssue(c, repo, number)
	if err != nil {
		status := http.StatusBadGateway
		var upstream *agentGitHubHTTPError
		if errors.As(err, &upstream) && (upstream.StatusCode == http.StatusUnauthorized || upstream.StatusCode == http.StatusForbidden || upstream.StatusCode == http.StatusNotFound || upstream.StatusCode == http.StatusTooManyRequests) {
			status = upstream.StatusCode
		}
		writeAgentError(c, status, "AGENT_GITHUB_REQUEST_FAILED", "GitHub issue read failed")
		return
	}
	common.ApiSuccess(c, result)
}

// readAgentGitHubIssue is shared by browser reads and the account-scoped DSH tool relay.
func readAgentGitHubIssue(c *gin.Context, repo string, number int) (agentGitHubIssueResult, error) {
	endpoint := fmt.Sprintf("https://api.github.com/repos/%s/issues/%d", repo, number)
	var raw map[string]any
	if err := agentGitHubRequest(c, http.MethodGet, endpoint, nil, &raw); err != nil {
		return agentGitHubIssueResult{}, err
	}
	items := normalizeAgentGitHubActivity([]map[string]any{raw}, false)
	if len(items) != 1 || items[0].Number != number {
		return agentGitHubIssueResult{}, errors.New("GitHub did not return the requested issue")
	}
	body, _ := raw["body"].(string)
	items[0].Body, items[0].BodyTruncated = boundedAgentGitHubText(body, 12*1024)
	items[0].Repository = repo
	comments := make([]agentGitHubIssueComment, 0, 3)
	commentCount, countKnown := raw["comments"].(float64)
	commentsTruncated := !countKnown || commentCount > 3
	commentError := ""
	if countKnown && commentCount > 0 {
		var rawComments []struct {
			Body string `json:"body"`
			URL  string `json:"html_url"`
			User struct {
				Login string `json:"login"`
			} `json:"user"`
		}
		if err := agentGitHubRequest(c, http.MethodGet, endpoint+"/comments?per_page=3", nil, &rawComments); err != nil {
			commentError = "GitHub issue comments could not be read"
			commentsTruncated = true
		} else {
			for _, comment := range rawComments {
				if len(comments) == 3 {
					break
				}
				text, truncated := boundedAgentGitHubText(comment.Body, 2*1024)
				comments = append(comments, agentGitHubIssueComment{Body: text, BodyTruncated: truncated, URL: comment.URL, Author: comment.User.Login})
			}
			commentsTruncated = commentCount > float64(len(comments))
		}
	}
	return agentGitHubIssueResult{Repo: repo, Items: items, Comments: comments,
		CommentsOrder: "oldest first", CommentsTruncated: commentsTruncated, CommentsError: commentError}, nil
}
