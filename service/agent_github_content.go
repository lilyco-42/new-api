package service

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/QuantumNous/new-api/common"
)

// AgentRepositoryContent identifies the exact commit and blob behind a bounded read.
type AgentRepositoryContent struct {
	Version   int                     `json:"version"`
	Repo      string                  `json:"repo"`
	Path      string                  `json:"path"`
	Commit    string                  `json:"commit"`
	Type      string                  `json:"type"`
	SHA       string                  `json:"sha,omitempty"`
	URL       string                  `json:"url"`
	Text      string                  `json:"text,omitempty"`
	Entries   []AgentRepositoryEntry `json:"entries,omitempty"`
	Truncated bool                    `json:"truncated"`
}

// AgentRepositoryEntry is file discovery metadata, not fetched file contents.
type AgentRepositoryEntry struct {
	Path string `json:"path"`
	Type string `json:"type"`
	SHA  string `json:"sha"`
}

type agentRepositoryFile struct {
	Type         string `json:"type"`
	Path         string `json:"path"`
	SHA          string `json:"sha"`
	Encoding     string `json:"encoding"`
	Content      string `json:"content"`
	Size         int    `json:"size"`
	Target       string `json:"target"`
	SubmoduleURL string `json:"submodule_git_url"`
}

// ValidAgentRepositoryContentTarget accepts a repository-relative path and an optional ref.
func ValidAgentRepositoryContentTarget(repo, filePath, ref string) bool {
	return workflowRepoPattern.MatchString(repo) && utf8.ValidString(filePath) &&
		utf8.ValidString(ref) && len(filePath) <= 1024 && len(ref) <= 200 &&
		strings.IndexFunc(filePath+ref, unicode.IsControl) < 0 &&
		!strings.Contains(filePath, "\\") && !strings.HasPrefix(filePath, "/") &&
		(filePath == "" || (path.Clean(filePath) == filePath && filePath != "." &&
			filePath != ".." && !strings.HasPrefix(filePath, "../")))
}

// ReadAgentRepositoryContent resolves a ref before reading at its immutable commit.
// It never follows redirects or repository-provided download URLs. Only bounded
// UTF-8 files and at most 40 directory entries are returned; credentials stay local.
func ReadAgentRepositoryContent(ctx context.Context, repo, filePath, ref, token string) (*AgentRepositoryContent, error) {
	if !ValidAgentRepositoryContentTarget(repo, filePath, ref) || strings.TrimSpace(token) == "" {
		return nil, errors.New("invalid GitHub repository content request")
	}
	ctx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	client := &http.Client{
		Timeout:       8 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	read := func(endpoint string, output any) error {
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://api.github.com/repos/"+repo+endpoint, nil)
		if err != nil {
			return err
		}
		request.Header.Set("Authorization", "Bearer "+token)
		request.Header.Set("Accept", "application/vnd.github+json")
		request.Header.Set("X-GitHub-Api-Version", "2022-11-28")
		request.Header.Set("User-Agent", "Lain42-Agent/1.0 (+https://lain42.top/agent)")
		response, err := client.Do(request)
		if err != nil {
			return errors.New("GitHub repository content is unreachable")
		}
		defer response.Body.Close()
		if response.StatusCode != http.StatusOK {
			return fmt.Errorf("GitHub repository read returned HTTP %d", response.StatusCode)
		}
		body, err := io.ReadAll(io.LimitReader(response.Body, 512*1024+1))
		if err != nil || len(body) > 512*1024 {
			return errors.New("GitHub repository response exceeded its limit or could not be read")
		}
		return common.Unmarshal(body, output)
	}
	query := url.Values{"per_page": {"1"}}
	if ref != "" {
		query.Set("sha", ref)
	}
	var commits []struct {
		SHA string `json:"sha"`
	}
	if err := read("/commits?"+query.Encode(), &commits); err != nil {
		return nil, err
	}
	if len(commits) != 1 || !workflowSHA.MatchString(commits[0].SHA) {
		return nil, errors.New("GitHub did not return a verifiable commit")
	}
	commit := commits[0].SHA
	segments := strings.Split(filePath, "/")
	for i := range segments {
		segments[i] = url.PathEscape(segments[i])
	}
	escapedPath := strings.Join(segments, "/")
	var raw json.RawMessage
	if err := read("/contents/"+escapedPath+"?ref="+url.QueryEscape(commit), &raw); err != nil {
		return nil, err
	}
	result := &AgentRepositoryContent{Version: 1, Repo: repo, Path: filePath, Commit: commit}
	if common.GetJsonType(raw) == "array" {
		var entries []agentRepositoryFile
		if err := common.Unmarshal(raw, &entries); err != nil {
			return nil, errors.New("GitHub directory response is invalid")
		}
		result.Type = "directory"
		result.URL = "https://github.com/" + repo + "/tree/" + commit
		if filePath != "" {
			result.URL += "/" + escapedPath
		}
		result.Entries = make([]AgentRepositoryEntry, 0, 40)
		result.Truncated = len(entries) > 40
		for i, entry := range entries {
			if i == 40 {
				break
			}
			if !ValidAgentRepositoryContentTarget(repo, entry.Path, "") ||
				path.Join(filePath, path.Base(entry.Path)) != entry.Path || !workflowSHA.MatchString(entry.SHA) ||
				(entry.Type != "file" && entry.Type != "dir" && entry.Type != "symlink" && entry.Type != "submodule") {
				return nil, errors.New("GitHub directory returned unsupported entries")
			}
			result.Entries = append(result.Entries, AgentRepositoryEntry{Path: entry.Path, Type: entry.Type, SHA: entry.SHA})
		}
		return result, nil
	}
	var file agentRepositoryFile
	if err := common.Unmarshal(raw, &file); err != nil || filePath == "" || file.Type != "file" || file.Path != filePath ||
		file.Encoding != "base64" || file.Size < 0 || file.Size > 64*1024 ||
		!workflowSHA.MatchString(file.SHA) || file.Target != "" || file.SubmoduleURL != "" {
		return nil, errors.New("GitHub did not return a supported text file of at most 64 KiB")
	}
	content, err := base64.StdEncoding.DecodeString(file.Content)
	if err != nil || len(content) != file.Size || !utf8.Valid(content) || strings.ContainsRune(string(content), 0) {
		return nil, errors.New("GitHub file content is not valid bounded UTF-8 text")
	}
	result.Type, result.SHA = "file", file.SHA
	result.URL = "https://github.com/" + repo + "/blob/" + commit + "/" + escapedPath
	result.Text = strings.ReplaceAll(string(content), token, "[redacted]")
	return result, nil
}
