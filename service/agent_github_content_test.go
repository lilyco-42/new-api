package service

import (
	"context"
	"encoding/base64"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestRepositoryContentPinsTheCommitAndReturnsOnlyVerifiedText(t *testing.T) {
	requests := 0
	text := "fn main() { println!(\"你好\"); }\naccount-token"
	installWorkflowTransport(t, func(r *http.Request) (*http.Response, error) {
		requests++
		assert.Equal(t, "Bearer account-token", r.Header.Get("Authorization"))
		assert.Equal(t, "api.github.com", r.URL.Host)
		if requests == 1 {
			assert.Equal(t, "/repos/owner/project/commits", r.URL.Path)
			assert.Equal(t, "feature/fix", r.URL.Query().Get("sha"))
			assert.Equal(t, "1", r.URL.Query().Get("per_page"))
			return workflowResponse(200, `[{"sha":"`+workflowTestSHA+`"}]`), nil
		}
		assert.Equal(t, "/repos/owner/project/contents/src/main.rs", r.URL.Path)
		assert.Equal(t, workflowTestSHA, r.URL.Query().Get("ref"))
		body, err := common.Marshal(map[string]any{"type": "file", "path": "src/main.rs", "sha": workflowTestSHA,
			"size": len(text), "encoding": "base64", "content": base64.StdEncoding.EncodeToString([]byte(text)),
			"download_url": "https://other.example/never-follow"})
		require.NoError(t, err)
		return workflowResponse(200, string(body)), nil
	})
	result, err := ReadAgentRepositoryContent(context.Background(), "owner/project", "src/main.rs", "feature/fix", "account-token")
	require.NoError(t, err)
	assert.Equal(t, workflowTestSHA, result.Commit)
	assert.Equal(t, workflowTestSHA, result.SHA)
	assert.Equal(t, "file", result.Type)
	assert.Equal(t, strings.ReplaceAll(text, "account-token", "[redacted]"), result.Text)
	assert.Equal(t, "https://github.com/owner/project/blob/"+workflowTestSHA+"/src/main.rs", result.URL)
	assert.False(t, result.Truncated)
	assert.Equal(t, 2, requests, "download URLs are metadata, not another fetch")
}

func TestRepositoryDirectoryDiscoveryIsBoundedAndDoesNotClaimFilesWereRead(t *testing.T) {
	requests := 0
	installWorkflowTransport(t, func(r *http.Request) (*http.Response, error) {
		requests++
		if strings.HasSuffix(r.URL.Path, "/commits") {
			assert.Empty(t, r.URL.Query().Get("sha"))
			return workflowResponse(200, `[{"sha":"`+workflowTestSHA+`"}]`), nil
		}
		entries := make([]agentRepositoryFile, 41)
		for i := range entries {
			entries[i] = agentRepositoryFile{Type: "file", Path: fmt.Sprintf("src/file-%d.rs", i), SHA: workflowTestSHA}
		}
		body, err := common.Marshal(entries)
		require.NoError(t, err)
		return workflowResponse(200, string(body)), nil
	})
	result, err := ReadAgentRepositoryContent(context.Background(), "owner/project", "src", "", "account-token")
	require.NoError(t, err)
	assert.Equal(t, "directory", result.Type)
	assert.Empty(t, result.Text)
	assert.Len(t, result.Entries, 40)
	assert.True(t, result.Truncated)
	assert.Equal(t, "https://github.com/owner/project/tree/"+workflowTestSHA+"/src", result.URL)
	assert.Equal(t, 2, requests)
}

func TestRepositoryContentRejectsUnverifiableFilesAndNeverFollowsRedirects(t *testing.T) {
	for _, scenario := range []struct {
		name   string
		status int
		file   agentRepositoryFile
	}{
		{"different path", 200, agentRepositoryFile{Type: "file", Path: "other.rs", SHA: workflowTestSHA, Encoding: "base64"}},
		{"oversized file", 200, agentRepositoryFile{Type: "file", Path: "main.rs", SHA: workflowTestSHA, Encoding: "base64", Size: 64*1024 + 1}},
		{"binary text", 200, agentRepositoryFile{Type: "file", Path: "main.rs", SHA: workflowTestSHA, Encoding: "base64", Size: 1, Content: "AA=="}},
		{"incorrect size", 200, agentRepositoryFile{Type: "file", Path: "main.rs", SHA: workflowTestSHA, Encoding: "base64", Size: 2, Content: "YQ=="}},
		{"symlink metadata", 200, agentRepositoryFile{Type: "file", Path: "main.rs", SHA: workflowTestSHA, Encoding: "base64", Target: "elsewhere"}},
		{"unauthorized", 401, agentRepositoryFile{}},
		{"not found", 404, agentRepositoryFile{}},
		{"limited", 429, agentRepositoryFile{}},
		{"redirect", 302, agentRepositoryFile{}},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			requests := 0
			installWorkflowTransport(t, func(r *http.Request) (*http.Response, error) {
				requests++
				if requests == 1 {
					return workflowResponse(200, `[{"sha":"`+workflowTestSHA+`"}]`), nil
				}
				body, err := common.Marshal(scenario.file)
				require.NoError(t, err)
				response := workflowResponse(scenario.status, string(body))
				response.Header.Set("Location", "https://other.example/capture")
				return response, nil
			})
			result, err := ReadAgentRepositoryContent(context.Background(), "owner/project", "main.rs", "", "account-token")
			require.Error(t, err)
			assert.Nil(t, result)
			assert.NotContains(t, err.Error(), "account-token")
			assert.Equal(t, 2, requests)
		})
	}
}

func TestRepositoryContentRejectsInvalidTargetsBeforeNetworkAccess(t *testing.T) {
	requests := 0
	installWorkflowTransport(t, func(*http.Request) (*http.Response, error) {
		requests++
		return workflowResponse(200, `[]`), nil
	})
	for _, scenario := range []struct{ repo, path, ref, token string }{
		{"owner/..", "main.rs", "", "token"},
		{"owner/project", "../secret", "", "token"},
		{"owner/project", "src/../secret", "", "token"},
		{"owner/project", "/etc/passwd", "", "token"},
		{"owner/project", "src\\main.rs", "", "token"},
		{"owner/project", "main.rs", "main\nheader", "token"},
		{"owner/project", "main.rs", "", ""},
	} {
		result, err := ReadAgentRepositoryContent(context.Background(), scenario.repo, scenario.path, scenario.ref, scenario.token)
		require.Error(t, err)
		assert.Nil(t, result)
	}
	assert.Zero(t, requests)
	result, err := ReadAgentRepositoryContent(context.Background(), "owner/project", "main.rs", "", "token")
	require.Error(t, err, "an empty repository must not become fabricated file evidence")
	assert.Nil(t, result)
	assert.Equal(t, 1, requests)
}
