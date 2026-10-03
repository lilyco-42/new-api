package service

import (
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/stretchr/testify/require"
)

type workflowTransport func(*http.Request) (*http.Response, error)

func (f workflowTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func workflowResponse(status int, body string) *http.Response {
	return &http.Response{StatusCode: status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}
}

func installWorkflowTransport(t *testing.T, f workflowTransport) {
	previous := http.DefaultTransport
	http.DefaultTransport = f
	t.Cleanup(func() { http.DefaultTransport = previous })
}

const workflowTestSHA = "0123456789012345678901234567890123456789"
const workflowTestRun = `{"id":17,"run_attempt":2,"head_sha":"` + workflowTestSHA + `","path":".github/workflows/ci.yml@refs/heads/main","status":"completed","conclusion":"failure"}`

func TestWorkflowEvidencePinsFileAndJobAttemptAndNeverLeaksCredentialToStorage(t *testing.T) {
	var paths []string
	file := "name: CI\njobs:\n  build:\n    runs-on: ubuntu-latest\n"
	installWorkflowTransport(t, func(req *http.Request) (*http.Response, error) {
		paths = append(paths, req.URL.RequestURI())
		if req.URL.Host == "logs.blob.core.windows.net" {
			require.Empty(t, req.Header.Get("Authorization"))
			require.Empty(t, req.Header.Get("Cookie"))
			return workflowResponse(200, "Error: invalid cargo argument\nowner-token"), nil
		}
		require.Equal(t, "api.github.com", req.URL.Host)
		require.Equal(t, "Bearer owner-token", req.Header.Get("Authorization"))
		switch req.URL.Path {
		case "/repos/merchant/project/actions/runs/17":
			return workflowResponse(200, workflowTestRun), nil
		case "/repos/merchant/project/contents/.github/workflows/ci.yml":
			require.Equal(t, workflowTestSHA, req.URL.Query().Get("ref"))
			return workflowResponse(200, fmt.Sprintf(`{"type":"file","path":".github/workflows/ci.yml","encoding":"base64","size":%d,"content":"%s"}`, len(file), base64.StdEncoding.EncodeToString([]byte(file)))), nil
		case "/repos/merchant/project/actions/runs/17/attempts/2/jobs":
			return workflowResponse(200, `{"total_count":1,"jobs":[{"id":23,"run_id":17,"head_sha":"`+workflowTestSHA+`","name":"build","conclusion":"failure","steps":[{"number":6,"name":"Typecheck","conclusion":"success"},{"number":7,"name":"Lint","conclusion":"failure"}]}]}`), nil
		case "/repos/merchant/project/actions/jobs/23/logs":
			response := workflowResponse(302, "")
			response.Header.Set("Location", "https://logs.blob.core.windows.net/job.txt?sig=private-signed-url")
			return response, nil
		default:
			t.Fatalf("unexpected read %s", req.URL)
			return nil, nil
		}
	})
	evidence, err := ReadAgentWorkflowEvidence(context.Background(), "merchant/project", 17, "owner-token")
	require.NoError(t, err)
	require.Equal(t, file, evidence.Workflow.Text)
	require.Equal(t, workflowTestSHA, evidence.Workflow.Ref)
	require.Len(t, evidence.Jobs, 1)
	require.Equal(t, []WorkflowStepEvidence{{Number: 7, Name: "Lint", Conclusion: "failure"}}, evidence.Jobs[0].FailedSteps)
	require.Contains(t, evidence.Jobs[0].Log, "invalid cargo argument")
	require.NotContains(t, evidence.Jobs[0].Log, "owner-token")
	require.Contains(t, evidence.Jobs[0].Log, "[redacted]")
	require.Empty(t, evidence.Problems)
	require.Len(t, paths, 5)
}

func TestWorkflowEvidenceRejectsRedirectsAndOversizedJSON(t *testing.T) {
	for _, status := range []int{302, 200} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			calls := 0
			installWorkflowTransport(t, func(req *http.Request) (*http.Response, error) {
				calls++
				response := workflowResponse(status, strings.Repeat("x", workflowJSONLimit+1))
				response.Header.Set("Location", "https://attacker.invalid/steal")
				return response, nil
			})
			_, err := ReadAgentWorkflowEvidence(context.Background(), "merchant/project", 17, "owner-token")
			require.Error(t, err)
			require.Equal(t, 1, calls)
		})
	}
}

func TestWorkflowEvidencePartialFailureDoesNotFabricateAFileOrLogs(t *testing.T) {
	installWorkflowTransport(t, func(req *http.Request) (*http.Response, error) {
		switch {
		case strings.Contains(req.URL.Path, "/contents/"):
			return workflowResponse(403, "permission denied"), nil
		case strings.HasSuffix(req.URL.Path, "/jobs"):
			return workflowResponse(200, `{"total_count":1,"jobs":[{"id":23,"run_id":17,"head_sha":"`+workflowTestSHA+`","name":"build","conclusion":"failure"}]}`), nil
		case strings.HasSuffix(req.URL.Path, "/logs"):
			response := workflowResponse(302, "")
			response.Header.Set("Location", "https://localhost/private")
			return response, nil
		default:
			return workflowResponse(200, workflowTestRun), nil
		}
	})
	evidence, err := ReadAgentWorkflowEvidence(context.Background(), "merchant/project", 17, "owner-token")
	require.NoError(t, err)
	require.Nil(t, evidence.Workflow)
	require.Len(t, evidence.Problems, 1)
	require.Contains(t, evidence.Problems[0], "403")
	require.Len(t, evidence.Jobs, 1)
	require.Empty(t, evidence.Jobs[0].Log)
	require.Contains(t, evidence.Jobs[0].LogError, "unsupported download host")
}

func TestWorkflowLogTransferAndTextBoundsAreVisibleAndUTF8Valid(t *testing.T) {
	installWorkflowTransport(t, func(req *http.Request) (*http.Response, error) {
		if req.URL.Host == "api.github.com" {
			response := workflowResponse(302, "")
			response.Header.Set("Location", "https://logs.blob.core.windows.net/job")
			return response, nil
		}
		return workflowResponse(200, strings.Repeat("修复", workflowLogTransferLimit)), nil
	})
	r := workflowEvidenceReader{token: "owner-token", client: &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
	log, truncated, err := r.readJobLog(context.Background(), "/repos/merchant/project/actions/jobs/23/logs")
	require.NoError(t, err)
	require.True(t, truncated)
	require.LessOrEqual(t, len(log), workflowLogTextLimit)
	require.True(t, utf8.ValidString(log))
}

func TestWorkflowEvidenceNewestFailureAndEmptyPage(t *testing.T) {
	for _, body := range []string{`{"workflow_runs":[]}`, `{"workflow_runs":[` + workflowTestRun + `]}`} {
		installWorkflowTransport(t, func(req *http.Request) (*http.Response, error) {
			if strings.HasSuffix(req.URL.Path, "/actions/runs") {
				require.Equal(t, "failure", req.URL.Query().Get("status"))
				require.Equal(t, "1", req.URL.Query().Get("per_page"))
				return workflowResponse(200, body), nil
			}
			return workflowResponse(404, ""), nil
		})
		evidence, err := ReadAgentWorkflowEvidence(context.Background(), "merchant/project", 0, "owner-token")
		require.NoError(t, err)
		require.NotEmpty(t, evidence.Problems)
		if strings.Contains(body, `"id"`) {
			require.Equal(t, int64(17), evidence.Run.ID)
		} else {
			require.Nil(t, evidence.Run)
		}
	}
}

func TestWorkflowEvidenceRejectsInvalidIdentityBeforeReading(t *testing.T) {
	installWorkflowTransport(t, func(*http.Request) (*http.Response, error) {
		t.Fatal("invalid request made a network call")
		return nil, nil
	})
	for _, repo := range []string{"../x", "merchant/project/extra", "https://github.com/m/p", "m/.."} {
		_, err := ReadAgentWorkflowEvidence(context.Background(), repo, 17, "token")
		require.Error(t, err)
	}
	_, err := ReadAgentWorkflowEvidence(context.Background(), "merchant/project", -1, "token")
	require.Error(t, err)
	_, err = ReadAgentWorkflowEvidence(context.Background(), "merchant/project", 17, "")
	require.Error(t, err)
}

func TestWorkflowEvidenceBoundsJobsAndRejectsCrossRunData(t *testing.T) {
	logs := 0
	installWorkflowTransport(t, func(req *http.Request) (*http.Response, error) {
		switch {
		case strings.Contains(req.URL.Path, "/contents/"):
			return workflowResponse(200, `{"type":"file","path":".github/workflows/ci.yml","encoding":"base64","size":65537,"content":""}`), nil
		case strings.HasSuffix(req.URL.Path, "/jobs"):
			jobs := []string{`{"id":999,"run_id":999,"head_sha":"` + workflowTestSHA + `","name":"wrong run","conclusion":"failure"}`}
			for i := 1; i < 25; i++ {
				jobs = append(jobs, fmt.Sprintf(`{"id":%d,"run_id":17,"head_sha":"%s","name":"job","conclusion":"failure"}`, i, workflowTestSHA))
			}
			return workflowResponse(200, `{"total_count":25,"jobs":[`+strings.Join(jobs, ",")+`]}`), nil
		case strings.HasSuffix(req.URL.Path, "/logs"):
			logs++
			return workflowResponse(403, ""), nil
		default:
			return workflowResponse(200, workflowTestRun), nil
		}
	})
	evidence, err := ReadAgentWorkflowEvidence(context.Background(), "merchant/project", 17, "owner-token")
	require.NoError(t, err)
	require.Nil(t, evidence.Workflow, "oversized file must not enter model context")
	require.True(t, evidence.JobsTruncated)
	require.Len(t, evidence.Jobs, 19)
	require.Len(t, evidence.Problems, 2)
	require.Equal(t, 3, logs)
	for _, job := range evidence.Jobs {
		require.Equal(t, int64(17), job.RunID)
		require.Empty(t, job.Log)
		require.NotEmpty(t, job.LogError)
	}
}

func TestWorkflowLogLocationRejectsUntrustedCredentialAndPrivateURLs(t *testing.T) {
	for _, raw := range []string{"http://logs.blob.core.windows.net/log", "https://localhost/log", "https://127.0.0.1/log", "https://logs.blob.core.windows.net.attacker.invalid/log", "https://user:password@logs.blob.core.windows.net/log", "https://logs.blob.core.windows.net:8443/log", "https://logs.blob.core.windows.net/log#fragment"} {
		require.False(t, validWorkflowLogLocation(raw), raw)
	}
	require.True(t, validWorkflowLogLocation("https://logs.blob.core.windows.net/log?sig=signed"))
	require.True(t, validWorkflowLogLocation("https://results.actions.githubusercontent.com/log?sig=signed"))
}
