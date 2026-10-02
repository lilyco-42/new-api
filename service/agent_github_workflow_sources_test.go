package service

import (
	"context"
	"encoding/base64"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestWorkflowAnnotationsResolveConfirmedWorkingDirectoryAtRunCommit(t *testing.T) {
	file := "jobs:\n  frontend:\n    name: Frontend\n    defaults:\n      run:\n        working-directory: web\n"
	source := "// first\nconst clean = value.replace(/foo/g, 'bar');\n// owner-token\n"
	var sourcePaths []string
	installWorkflowTransport(t, func(req *http.Request) (*http.Response, error) {
		require.Equal(t, "api.github.com", req.URL.Host)
		require.Equal(t, "Bearer owner-token", req.Header.Get("Authorization"))
		switch req.URL.Path {
		case "/repos/merchant/project/actions/runs/17":
			return workflowResponse(200, workflowTestRun), nil
		case "/repos/merchant/project/actions/runs/17/attempts/2/jobs":
			return workflowResponse(200, `{"total_count":1,"jobs":[{"id":23,"run_id":17,"head_sha":"`+workflowTestSHA+`","name":"Frontend","conclusion":"failure","check_run_url":"https://api.github.com/repos/merchant/project/check-runs/99"}]}`), nil
		case "/repos/merchant/project/check-runs/99":
			return workflowResponse(200, `{"id":99,"head_sha":"`+workflowTestSHA+`","details_url":"https://github.com/merchant/project/actions/runs/17/job/23","output":{"annotations_count":9}}`), nil
		case "/repos/merchant/project/check-runs/99/annotations":
			require.Equal(t, "8", req.URL.Query().Get("per_page"))
			return workflowResponse(200, `[{"path":"src/tool.ts","start_line":2,"end_line":2,"annotation_level":"failure","message":"replaceAll owner-token"},{"path":"../secret.ts","start_line":1,"end_line":1,"annotation_level":"failure","message":"untrusted"}]`), nil
		case "/repos/merchant/project/contents/.github/workflows/ci.yml":
			require.Equal(t, workflowTestSHA, req.URL.Query().Get("ref"))
			return workflowResponse(200, fmt.Sprintf(`{"type":"file","path":".github/workflows/ci.yml","encoding":"base64","size":%d,"content":"%s"}`, len(file), base64.StdEncoding.EncodeToString([]byte(file)))), nil
		case "/repos/merchant/project/contents/src/tool.ts":
			require.Equal(t, workflowTestSHA, req.URL.Query().Get("ref"))
			sourcePaths = append(sourcePaths, "src/tool.ts")
			return workflowResponse(404, ""), nil
		case "/repos/merchant/project/contents/web/src/tool.ts":
			require.Equal(t, workflowTestSHA, req.URL.Query().Get("ref"))
			sourcePaths = append(sourcePaths, "web/src/tool.ts")
			return workflowResponse(200, fmt.Sprintf(`{"type":"file","path":"web/src/tool.ts","encoding":"base64","size":%d,"content":"%s"}`, len(source), base64.StdEncoding.EncodeToString([]byte(source)))), nil
		case "/repos/merchant/project/actions/jobs/23/logs":
			return workflowResponse(403, ""), nil
		default:
			t.Fatalf("unexpected read %s", req.URL)
			return nil, nil
		}
	})
	evidence, err := ReadAgentWorkflowEvidence(context.Background(), "merchant/project", 17, "owner-token")
	require.NoError(t, err)
	require.Equal(t, []string{"src/tool.ts", "web/src/tool.ts"}, sourcePaths)
	require.Len(t, evidence.Sources, 1)
	require.Equal(t, "web/src/tool.ts", evidence.Sources[0].Path)
	require.Equal(t, workflowTestSHA, evidence.Sources[0].Ref)
	require.Contains(t, evidence.Sources[0].Text, "2: const clean = value.replace(/foo/g, 'bar');")
	require.NotContains(t, evidence.Sources[0].Text, "owner-token")
	require.Contains(t, evidence.Sources[0].URL, "/blob/"+workflowTestSHA+"/web/src/tool.ts#L2")
	require.Len(t, evidence.Jobs[0].Annotations, 2)
	require.NotContains(t, evidence.Jobs[0].Annotations[0].Message, "owner-token")
	require.True(t, evidence.Jobs[0].AnnotationsTruncated)
}

func TestWorkflowAnnotationsRejectAnotherJobCommitAndUntrustedURL(t *testing.T) {
	for _, checkURL := range []string{"https://api.github.com/repos/merchant/project/check-runs/99", "https://attacker.invalid/repos/merchant/project/check-runs/99"} {
		t.Run(checkURL, func(t *testing.T) {
			calls := 0
			installWorkflowTransport(t, func(req *http.Request) (*http.Response, error) {
				calls++
				require.Equal(t, "/repos/merchant/project/check-runs/99", req.URL.Path)
				return workflowResponse(200, `{"id":99,"head_sha":"`+strings.Repeat("a", 40)+`","details_url":"https://github.com/merchant/project/actions/runs/17/job/23"}`), nil
			})
			job := WorkflowJobEvidence{ID: 23, URL: "https://github.com/merchant/project/actions/runs/17/job/23"}
			evidence := &WorkflowEvidence{}
			r := workflowEvidenceReader{token: "owner-token", client: &http.Client{}}
			r.readFailureSources(context.Background(), "/repos/merchant/project", "merchant/project", WorkflowRunEvidence{HeadSHA: workflowTestSHA}, checkURL, &job, evidence)
			require.NotEmpty(t, job.AnnotationError)
			require.Empty(t, job.Annotations)
			require.Empty(t, evidence.Sources)
			if strings.Contains(checkURL, "attacker") {
				require.Zero(t, calls)
			} else {
				require.Equal(t, 1, calls)
			}
		})
	}
}

func TestWorkflowSourceFailureIsNotARootOrWorkingDirectoryGuess(t *testing.T) {
	for _, status := range []int{403, 200} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			installWorkflowTransport(t, func(req *http.Request) (*http.Response, error) {
				require.Equal(t, "/repos/m/p/contents/src/tool.ts", req.URL.Path)
				return workflowResponse(status, `{"type":"symlink","path":"src/tool.ts","size":1,"encoding":"base64","content":"YQ=="}`), nil
			})
			r := workflowEvidenceReader{token: "token", client: &http.Client{}}
			_, err := r.readDiagnosticSource(context.Background(), "/repos/m/p", "src/tool.ts", workflowTestSHA)
			require.Error(t, err)
			require.NotErrorIs(t, err, errWorkflowSourceNotFound)
		})
	}
	for _, invalid := range []string{"../secret.ts", "/etc/a.ts", "x/../a.ts", "x\\a.ts", "x/.env", "x/key.pem", "${{env.WORK}}/a.ts"} {
		require.False(t, validWorkflowSourcePath(invalid))
	}
	file := &WorkflowFileEvidence{Text: "jobs:\n  a:\n    name: Same\n    defaults:\n      run:\n        working-directory: web\n  b:\n    name: Same\n"}
	require.Empty(t, workflowDiagnosticDirectory(file, WorkflowJobEvidence{Name: "Same"}))
}

func TestWorkflowDiagnosticSourcesBoundReadsAndKeepActualErrorLine(t *testing.T) {
	reads := 0
	installWorkflowTransport(t, func(req *http.Request) (*http.Response, error) {
		switch req.URL.Path {
		case "/repos/m/p/check-runs/99":
			return workflowResponse(200, `{"id":99,"head_sha":"`+workflowTestSHA+`","details_url":"https://github.com/m/p/actions/runs/17/job/23","output":{"annotations_count":4}}`), nil
		case "/repos/m/p/check-runs/99/annotations":
			return workflowResponse(200, `[{"path":"src/a.ts","start_line":6,"end_line":6,"annotation_level":"failure"},{"path":"src/b.ts","start_line":6,"end_line":6,"annotation_level":"failure"},{"path":"src/c.ts","start_line":6,"end_line":6,"annotation_level":"failure"},{"path":"src/d.ts","start_line":6,"end_line":6,"annotation_level":"failure"}]`), nil
		default:
			reads++
			require.NotContains(t, req.URL.Path, "src/d.ts")
			require.Equal(t, workflowTestSHA, req.URL.Query().Get("ref"))
			file := strings.Repeat(strings.Repeat("修", 900)+"\n", 5) + "const actualError = value.replace(/foo/g, 'bar');\n" + strings.Repeat("// context\n", 20)
			return workflowResponse(200, fmt.Sprintf(`{"type":"file","path":"%s","encoding":"base64","size":%d,"content":"%s"}`, strings.TrimPrefix(req.URL.Path, "/repos/m/p/contents/"), len(file), base64.StdEncoding.EncodeToString([]byte(file)))), nil
		}
	})
	r := workflowEvidenceReader{token: "token", client: &http.Client{}}
	job := WorkflowJobEvidence{ID: 23, URL: "https://github.com/m/p/actions/runs/17/job/23"}
	evidence := &WorkflowEvidence{}
	r.readFailureSources(context.Background(), "/repos/m/p", "m/p", WorkflowRunEvidence{HeadSHA: workflowTestSHA}, "https://api.github.com/repos/m/p/check-runs/99", &job, evidence)
	require.Equal(t, 3, reads)
	require.Len(t, evidence.Sources, 3)
	require.True(t, job.AnnotationsTruncated)
	for _, source := range evidence.Sources {
		require.Contains(t, source.Text, "6: const actualError = value.replace(/foo/g, 'bar');")
		require.LessOrEqual(t, len(source.Text), 2000)
		require.True(t, source.Truncated)
	}
}
