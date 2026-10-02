package controller

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func TestWorkflowEvidenceControllerDoesNotInheritAnotherUsersOAuth(t *testing.T) {
	setupAgentDSHControllerTest(t)
	require.NoError(t, model.DB.AutoMigrate(&model.AgentGitHubCredential{}))
	previous := common.CryptoSecret
	common.CryptoSecret = "workflow-account-contract"
	t.Cleanup(func() { common.CryptoSecret = previous })
	require.NoError(t, model.SaveAgentGitHubCredential(42, "github-owner", "owner", "repo", "owner-token"))
	previousTransport := http.DefaultTransport
	calls := 0
	http.DefaultTransport = agentGitHubRoundTripper(func(req *http.Request) (*http.Response, error) {
		calls++
		require.Equal(t, "Bearer owner-token", req.Header.Get("Authorization"))
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"workflow_runs":[]}`))}, nil
	})
	t.Cleanup(func() { http.DefaultTransport = previousTransport })
	for _, user := range []int{42, 43} {
		recorder := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(recorder)
		c.Request = httptest.NewRequest(http.MethodGet, "/api/agent/github/workflow-evidence?repo=merchant/project", nil)
		c.Set("id", user)
		AgentGitHubWorkflowEvidence(c)
		if user == 42 {
			require.Equal(t, 200, recorder.Code)
		} else {
			require.Equal(t, 409, recorder.Code)
		}
		require.NotContains(t, recorder.Body.String(), "owner-token")
	}
	require.Equal(t, 1, calls)
}

func TestWorkflowEvidenceControllerRejectsInvalidQueryBeforeCredentialLookup(t *testing.T) {
	for _, query := range []string{"repo=merchant/project&run_id=0", "repo=merchant/project&run_id=1.5", "repo=../x", "repo=merchant/project&run_id=9223372036854775808"} {
		recorder := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(recorder)
		c.Request = httptest.NewRequest(http.MethodGet, "/api/agent/github/workflow-evidence?"+query, nil)
		AgentGitHubWorkflowEvidence(c)
		require.Equal(t, 400, recorder.Code)
	}
}
