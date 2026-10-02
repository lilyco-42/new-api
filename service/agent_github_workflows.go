package service

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/QuantumNous/new-api/common"
)

const workflowJSONLimit = 512 * 1024
const workflowFileLimit = 64 * 1024
const workflowLogTransferLimit = 128 * 1024
const workflowLogTextLimit = 12 * 1024

var workflowRepoPattern = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$`)
var workflowSHA = regexp.MustCompile(`^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$`)
var workflowFilePattern = regexp.MustCompile(`^\.github/workflows/[A-Za-z0-9_.-]+\.ya?ml$`)

// WorkflowEvidence is a bounded read, not permission to modify or execute code.
// Partial failures stay visible so a model cannot claim it inspected missing logs.
type WorkflowEvidence struct {
	Repo          string                   `json:"repo"`
	FetchedAt     string                   `json:"fetched_at"`
	Run           *WorkflowRunEvidence     `json:"run,omitempty"`
	Workflow      *WorkflowFileEvidence    `json:"workflow,omitempty"`
	Jobs          []WorkflowJobEvidence    `json:"jobs"`
	JobsTruncated bool                     `json:"jobs_truncated"`
	Problems      []string                 `json:"problems"`
	Sources       []WorkflowSourceEvidence `json:"sources,omitempty"`
}

type WorkflowRunEvidence struct {
	ID         int64  `json:"id"`
	Attempt    int    `json:"run_attempt"`
	HeadSHA    string `json:"head_sha"`
	Path       string `json:"path"`
	Status     string `json:"status"`
	Conclusion string `json:"conclusion"`
	URL        string `json:"url"`
}

type WorkflowFileEvidence struct {
	Path string `json:"path"`
	Ref  string `json:"ref"`
	Text string `json:"text"`
	URL  string `json:"url"`
}

type WorkflowJobEvidence struct {
	ID                   int64                        `json:"id"`
	RunID                int64                        `json:"run_id"`
	HeadSHA              string                       `json:"head_sha"`
	Name                 string                       `json:"name"`
	Status               string                       `json:"status"`
	Conclusion           string                       `json:"conclusion"`
	URL                  string                       `json:"url"`
	Log                  string                       `json:"log,omitempty"`
	LogTruncated         bool                         `json:"log_truncated"`
	LogError             string                       `json:"log_error,omitempty"`
	FailedSteps          []WorkflowStepEvidence       `json:"failed_steps,omitempty"`
	FailedStepsTruncated bool                         `json:"failed_steps_truncated"`
	Annotations          []WorkflowAnnotationEvidence `json:"annotations,omitempty"`
	AnnotationsTruncated bool                         `json:"annotations_truncated"`
	AnnotationError      string                       `json:"annotation_error,omitempty"`
}

type WorkflowStepEvidence struct {
	Number     int    `json:"number"`
	Name       string `json:"name"`
	Conclusion string `json:"conclusion"`
}

func ValidWorkflowEvidenceTarget(repo string, runID int64) bool {
	return workflowRepoPattern.MatchString(repo) && runID >= 0
}

type workflowEvidenceReader struct {
	client *http.Client
	token  string
}

// ReadAgentWorkflowEvidence uses only the caller's credential and fixed GitHub
// endpoints. An absent run ID selects the newest returned failed run, not a guessed file.
func ReadAgentWorkflowEvidence(ctx context.Context, repo string, runID int64, token string) (*WorkflowEvidence, error) {
	if !ValidWorkflowEvidenceTarget(repo, runID) || strings.TrimSpace(token) == "" {
		return nil, errors.New("invalid workflow evidence request")
	}
	ctx, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()
	r := workflowEvidenceReader{token: token, client: &http.Client{Timeout: 8 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
	evidence := &WorkflowEvidence{Repo: repo, FetchedAt: time.Now().UTC().Format(time.RFC3339),
		Jobs: []WorkflowJobEvidence{}, Problems: []string{}}
	base := "/repos/" + repo
	var run WorkflowRunEvidence
	if runID == 0 {
		var page struct {
			Runs []WorkflowRunEvidence `json:"workflow_runs"`
		}
		if err := r.readJSON(ctx, base+"/actions/runs?status=failure&per_page=1&page=1", &page); err != nil {
			return nil, err
		}
		if len(page.Runs) == 0 {
			evidence.Problems = append(evidence.Problems, "no failed run returned")
			return evidence, nil
		}
		run = page.Runs[0]
	} else if err := r.readJSON(ctx, fmt.Sprintf("%s/actions/runs/%d", base, runID), &run); err != nil {
		return nil, err
	}
	if run.ID <= 0 || (runID != 0 && run.ID != runID) || run.Attempt < 1 || !workflowSHA.MatchString(run.HeadSHA) {
		return nil, errors.New("invalid GitHub workflow run identity")
	}
	run.URL = fmt.Sprintf("https://github.com/%s/actions/runs/%d/attempts/%d", repo, run.ID, run.Attempt)
	// GitHub may append @refs/... to the workflow path. Never use a branch ref
	// for file retrieval: failures must be explained against the run's commit.
	run.Path = strings.SplitN(run.Path, "@", 2)[0]
	run.Status = normalizedWorkflowStatus(run.Status)
	run.Conclusion = normalizedWorkflowStatus(run.Conclusion)
	if !workflowFilePattern.MatchString(run.Path) {
		run.Path = ""
	}
	evidence.Run = &run
	if workflowFilePattern.MatchString(run.Path) {
		file, err := r.readWorkflowFile(ctx, base, repo, run)
		if err != nil {
			evidence.Problems = append(evidence.Problems, err.Error())
		} else {
			evidence.Workflow = file
		}
	} else {
		evidence.Problems = append(evidence.Problems, "run did not return a supported workflow file path")
	}
	var jobs struct {
		Total int `json:"total_count"`
		Jobs  []struct {
			WorkflowJobEvidence
			Steps       []WorkflowStepEvidence `json:"steps"`
			CheckRunURL string                 `json:"check_run_url"`
		} `json:"jobs"`
	}
	endpoint := fmt.Sprintf("%s/actions/runs/%d/attempts/%d/jobs?per_page=20&page=1", base, run.ID, run.Attempt)
	if err := r.readJSON(ctx, endpoint, &jobs); err != nil {
		evidence.Problems = append(evidence.Problems, "job list unavailable: "+err.Error())
		return evidence, nil
	}
	evidence.JobsTruncated = jobs.Total > 20 || len(jobs.Jobs) > 20
	logsRead := 0
	for i, rawJob := range jobs.Jobs {
		if i >= 20 {
			break
		}
		job := rawJob.WorkflowJobEvidence
		if job.ID <= 0 || job.RunID != run.ID || job.HeadSHA != run.HeadSHA {
			evidence.Problems = append(evidence.Problems, "job identity did not match the selected run")
			continue
		}
		// Ignore upstream text and URLs in fields not needed for this contract.
		job.Log, job.LogError, job.LogTruncated = "", "", false
		job.FailedSteps, job.FailedStepsTruncated = nil, false
		job.Annotations, job.AnnotationsTruncated, job.AnnotationError = nil, false, ""
		for _, step := range rawJob.Steps {
			if step.Conclusion != "failure" && step.Conclusion != "timed_out" {
				continue
			}
			if step.Number < 1 || step.Number > 10000 {
				continue
			}
			if len(job.FailedSteps) >= 8 {
				job.FailedStepsTruncated = true
				break
			}
			step.Name = boundedWorkflowText(strings.ReplaceAll(step.Name, token, "[redacted]"), 256)
			job.FailedSteps = append(job.FailedSteps, step)
		}
		job.Status = normalizedWorkflowStatus(job.Status)
		job.Conclusion = normalizedWorkflowStatus(job.Conclusion)
		job.Name = boundedWorkflowText(strings.ReplaceAll(job.Name, token, "[redacted]"), 256)
		job.URL = fmt.Sprintf("https://github.com/%s/actions/runs/%d/job/%d", repo, run.ID, job.ID)
		if job.Conclusion == "failure" || job.Conclusion == "timed_out" {
			if logsRead < 3 {
				logsRead++
				r.readFailureSources(ctx, base, repo, run, rawJob.CheckRunURL, &job, evidence)
				log, truncated, err := r.readJobLog(ctx, fmt.Sprintf("%s/actions/jobs/%d/logs", base, job.ID))
				if err != nil {
					job.LogError = err.Error()
				} else {
					job.Log, job.LogTruncated = log, truncated
				}
			} else {
				job.LogError = "log omitted: three-job read limit"
			}
		}
		evidence.Jobs = append(evidence.Jobs, job)
	}
	return evidence, nil
}

func (r workflowEvidenceReader) request(ctx context.Context, endpoint string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://api.github.com"+endpoint, nil)
	if err != nil {
		return nil, errors.New("invalid GitHub request")
	}
	req.Header.Set("Authorization", "Bearer "+r.token)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	req.Header.Set("User-Agent", "Lain42-Agent")
	response, err := r.client.Do(req)
	if err != nil {
		return nil, errors.New("GitHub request unavailable or cancelled")
	}
	return response, nil
}

func (r workflowEvidenceReader) readJSON(ctx context.Context, endpoint string, output any) error {
	response, err := r.request(ctx, endpoint)
	if err != nil {
		return err
	}
	return r.decodeJSONResponse(response, output)
}

func (r workflowEvidenceReader) decodeJSONResponse(response *http.Response, output any) error {
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("GitHub returned HTTP %d", response.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, workflowJSONLimit+1))
	if err != nil || len(body) > workflowJSONLimit {
		return errors.New("GitHub JSON exceeded the read limit or could not be read")
	}
	if common.Unmarshal(body, output) != nil {
		return errors.New("invalid GitHub JSON")
	}
	return nil
}

func (r workflowEvidenceReader) readWorkflowFile(ctx context.Context, base, repo string, run WorkflowRunEvidence) (*WorkflowFileEvidence, error) {
	var file struct {
		Type     string `json:"type"`
		Path     string `json:"path"`
		Encoding string `json:"encoding"`
		Content  string `json:"content"`
		Size     int    `json:"size"`
	}
	if err := r.readJSON(ctx, base+"/contents/"+run.Path+"?ref="+url.QueryEscape(run.HeadSHA), &file); err != nil {
		return nil, fmt.Errorf("workflow file unavailable: %w", err)
	}
	if file.Type != "file" || file.Path != run.Path || file.Encoding != "base64" || file.Size < 0 || file.Size > workflowFileLimit {
		return nil, errors.New("workflow file unsupported or exceeds 64 KiB")
	}
	body, err := base64.StdEncoding.DecodeString(file.Content)
	if err != nil || len(body) > workflowFileLimit || len(body) != file.Size || !utf8.Valid(body) {
		return nil, errors.New("invalid workflow file content")
	}
	return &WorkflowFileEvidence{Path: run.Path, Ref: run.HeadSHA,
		Text: strings.ReplaceAll(string(body), r.token, "[redacted]"),
		URL:  "https://github.com/" + repo + "/blob/" + run.HeadSHA + "/" + run.Path}, nil
}

func validWorkflowLogLocation(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.User != nil || u.Port() != "" || u.Fragment != "" {
		return false
	}
	host := strings.ToLower(u.Hostname())
	return strings.HasSuffix(host, ".blob.core.windows.net") || strings.HasSuffix(host, ".actions.githubusercontent.com")
}

func (r workflowEvidenceReader) readJobLog(ctx context.Context, endpoint string) (string, bool, error) {
	response, err := r.request(ctx, endpoint)
	if err != nil {
		return "", false, err
	}
	location := response.Header.Get("Location")
	response.Body.Close()
	if response.StatusCode != http.StatusFound || !validWorkflowLogLocation(location) {
		return "", false, errors.New("job log unavailable or unsupported download host (HTTP " + strconv.Itoa(response.StatusCode) + ")")
	}
	// Signed storage URL receives no GitHub token, cookies, or ambient credentials.
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, location, nil)
	if err != nil {
		return "", false, errors.New("invalid log download")
	}
	response, err = r.client.Do(req)
	if err != nil {
		return "", false, errors.New("job log download unavailable or cancelled")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", false, fmt.Errorf("job log download returned HTTP %d", response.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, workflowLogTransferLimit+1))
	if err != nil {
		return "", false, errors.New("job log could not be read")
	}
	truncated := len(body) > workflowLogTransferLimit || len(body) > workflowLogTextLimit
	if len(body) > workflowLogTransferLimit {
		body = body[:workflowLogTransferLimit]
	}
	text := strings.ToValidUTF8(string(body), "�")
	text = strings.ReplaceAll(text, r.token, "[redacted]")
	if len(text) > workflowLogTextLimit {
		// Tail of the bounded prefix. Explicit truncation prevents claiming full logs.
		text = text[len(text)-workflowLogTextLimit:]
		for !utf8.ValidString(text) && len(text) > 0 {
			text = text[1:]
		}
	}
	return text, truncated, nil
}

func boundedWorkflowText(text string, limit int) string {
	if len(text) <= limit {
		return text
	}
	text = text[:limit]
	for !utf8.ValidString(text) && len(text) > 0 {
		text = text[:len(text)-1]
	}
	return text
}

func normalizedWorkflowStatus(value string) string {
	switch value {
	case "queued", "in_progress", "completed", "waiting", "pending", "requested", "success", "failure", "cancelled", "skipped", "timed_out", "action_required", "neutral", "stale", "":
		return value
	default:
		return "unknown"
	}
}
