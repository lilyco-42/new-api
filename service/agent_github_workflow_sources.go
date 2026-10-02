package service

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"net/url"
	"path"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"gopkg.in/yaml.v3"
)

type WorkflowAnnotationEvidence struct {
	Path      string `json:"path"`
	StartLine int    `json:"start_line"`
	EndLine   int    `json:"end_line"`
	Level     string `json:"annotation_level"`
	Message   string `json:"message"`
}

type WorkflowSourceEvidence struct {
	AnnotationPath string `json:"annotation_path"`
	Path           string `json:"path"`
	Ref            string `json:"ref"`
	JobID          int64  `json:"job_id"`
	ErrorLine      int    `json:"error_line"`
	StartLine      int    `json:"start_line"`
	EndLine        int    `json:"end_line"`
	Text           string `json:"text"`
	URL            string `json:"url"`
	Truncated      bool   `json:"excerpt_truncated"`
	Error          string `json:"error,omitempty"`
}

var workflowSourcePath = regexp.MustCompile(`^[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*\.(?:[cm]?jsx?|tsx?|rs|go|py|c|cpp|h|hpp|sh|css)$`)

func validWorkflowSourcePath(value string) bool {
	if len(value) > 512 || !workflowSourcePath.MatchString(value) {
		return false
	}
	for _, part := range strings.Split(value, "/") {
		if part == "." || part == ".." {
			return false
		}
	}
	return true
}

// Resolve relative diagnostics only against a uniquely identified static job/step
// working directory in the actual workflow. Matrix/expression ambiguity is not guessed.
func workflowDiagnosticDirectory(file *WorkflowFileEvidence, job WorkflowJobEvidence) string {
	if file == nil {
		return ""
	}
	type defaults struct {
		Run struct {
			Directory string `yaml:"working-directory"`
		} `yaml:"run"`
	}
	var config struct {
		Defaults defaults `yaml:"defaults"`
		Jobs     map[string]struct {
			Name     string   `yaml:"name"`
			Defaults defaults `yaml:"defaults"`
			Steps    []struct {
				Name      string `yaml:"name"`
				Directory string `yaml:"working-directory"`
			} `yaml:"steps"`
		} `yaml:"jobs"`
	}
	if yaml.Unmarshal([]byte(file.Text), &config) != nil {
		return ""
	}
	directory := ""
	matches := 0
	for key, entry := range config.Jobs {
		name := entry.Name
		if name == "" {
			name = key
		}
		if name != job.Name {
			continue
		}
		matches++
		directory = config.Defaults.Run.Directory
		if entry.Defaults.Run.Directory != "" {
			directory = entry.Defaults.Run.Directory
		}
		// Different failing steps cannot be collapsed into a guessed directory.
		for _, failure := range job.FailedSteps {
			for _, step := range entry.Steps {
				if step.Name == failure.Name && step.Directory != "" {
					if len(job.FailedSteps) != 1 {
						return ""
					}
					directory = step.Directory
				}
			}
		}
	}
	if matches != 1 || directory == "" || strings.HasPrefix(directory, "/") || strings.Contains(directory, "\\") {
		return ""
	}
	directory = strings.TrimPrefix(directory, "./")
	if !validWorkflowSourcePath(directory + "/placeholder.ts") {
		return ""
	}
	return directory
}

func (r workflowEvidenceReader) readFailureSources(ctx context.Context, base, repo string, run WorkflowRunEvidence, checkURL string, job *WorkflowJobEvidence, evidence *WorkflowEvidence) {
	// Never follow an arbitrary upstream URL or assume the job id equals a check id.
	u, err := url.Parse(checkURL)
	prefix := base + "/check-runs/"
	if err != nil || u.Scheme != "https" || u.Host != "api.github.com" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || !strings.HasPrefix(u.Path, prefix) {
		job.AnnotationError = "check-run identity unavailable or unsupported"
		return
	}
	idText := strings.TrimPrefix(u.Path, prefix)
	id, err := strconv.ParseInt(idText, 10, 64)
	if err != nil || id <= 0 || strconv.FormatInt(id, 10) != idText {
		job.AnnotationError = "invalid check-run identity"
		return
	}
	var check struct {
		ID         int64  `json:"id"`
		HeadSHA    string `json:"head_sha"`
		DetailsURL string `json:"details_url"`
		Output     struct {
			Count int `json:"annotations_count"`
		} `json:"output"`
	}
	if err = r.readJSON(ctx, u.Path, &check); err != nil {
		job.AnnotationError = "check run unavailable: " + err.Error()
		return
	}
	if check.ID != id || check.HeadSHA != run.HeadSHA || check.DetailsURL != job.URL {
		job.AnnotationError = "check run did not match the selected job and commit"
		return
	}
	var annotations []WorkflowAnnotationEvidence
	if err = r.readJSON(ctx, u.Path+"/annotations?per_page=8&page=1", &annotations); err != nil {
		job.AnnotationError = "annotations unavailable: " + err.Error()
		return
	}
	job.AnnotationsTruncated = check.Output.Count > 8 || len(annotations) > 8
	directory := workflowDiagnosticDirectory(evidence.Workflow, *job)
	for i, a := range annotations {
		if i >= 8 {
			break
		}
		if a.Level != "failure" && a.Level != "warning" && a.Level != "notice" {
			continue
		}
		if a.StartLine < 1 || a.EndLine < a.StartLine || a.EndLine > 1000000 {
			continue
		}
		a.Path = boundedWorkflowText(strings.ReplaceAll(a.Path, r.token, "[redacted]"), 512)
		a.Message = boundedWorkflowText(strings.ReplaceAll(a.Message, r.token, "[redacted]"), 512)
		job.Annotations = append(job.Annotations, a)
		if a.Level != "failure" || !validWorkflowSourcePath(a.Path) {
			continue
		}
		if len(evidence.Sources) >= 3 {
			job.AnnotationsTruncated = true
			continue
		}
		source := WorkflowSourceEvidence{AnnotationPath: a.Path, Path: a.Path, Ref: run.HeadSHA, JobID: job.ID, ErrorLine: a.StartLine}
		text, err := r.readDiagnosticSource(ctx, base, source.Path, run.HeadSHA)
		// A relative diagnostic may name a file under the workflow working directory.
		// Only a confirmed 404 permits the one explicitly configured resolution.
		if errors.Is(err, errWorkflowSourceNotFound) && directory != "" {
			source.Path = directory + "/" + a.Path
			text, err = r.readDiagnosticSource(ctx, base, source.Path, run.HeadSHA)
		}
		if err != nil {
			source.Error = err.Error()
			evidence.Sources = append(evidence.Sources, source)
			continue
		}
		lines := strings.Split(text, "\n")
		if a.StartLine > len(lines) {
			source.Error = "annotation line outside the source at the run commit"
			evidence.Sources = append(evidence.Sources, source)
			continue
		}
		source.StartLine = max(1, a.StartLine-5)
		source.EndLine = min(len(lines), a.StartLine+5)
		var excerpt strings.Builder
		for line := source.StartLine; line <= source.EndLine; line++ {
			lineLimit := 120
			if line == a.StartLine {
				lineLimit = 800
			}
			lineText := boundedWorkflowText(lines[line-1], lineLimit)
			if len(lineText) < len(lines[line-1]) {
				source.Truncated = true
			}
			fmt.Fprintf(&excerpt, "%d: %s\n", line, lineText)
		}
		source.Text = boundedWorkflowText(excerpt.String(), 2000)
		source.Truncated = source.Truncated || len(excerpt.String()) > 2000 || source.StartLine > 1 || source.EndLine < len(lines)
		source.URL = fmt.Sprintf("https://github.com/%s/blob/%s/%s#L%d", repo, run.HeadSHA, source.Path, a.StartLine)
		evidence.Sources = append(evidence.Sources, source)
	}
}

var errWorkflowSourceNotFound = errors.New("diagnostic source not found at the run commit")

func (r workflowEvidenceReader) readDiagnosticSource(ctx context.Context, base, filePath, ref string) (string, error) {
	if !validWorkflowSourcePath(filePath) {
		return "", errors.New("unsupported diagnostic source path")
	}
	var file struct {
		Type     string `json:"type"`
		Path     string `json:"path"`
		Encoding string `json:"encoding"`
		Content  string `json:"content"`
		Size     int    `json:"size"`
	}
	// Keep the same fixed host, response byte cap and no-redirect contract as all reads.
	endpoint := base + "/contents/" + filePath + "?ref=" + url.QueryEscape(ref)
	response, err := r.request(ctx, endpoint)
	if err != nil {
		return "", err
	}
	if response.StatusCode == 404 {
		response.Body.Close()
		return "", errWorkflowSourceNotFound
	}
	if err = r.decodeJSONResponse(response, &file); err != nil {
		return "", err
	}
	if file.Type != "file" || file.Path != filePath || file.Encoding != "base64" || file.Size < 0 || file.Size > 256*1024 || path.Clean(filePath) != filePath {
		return "", errors.New("diagnostic source unsupported or exceeds 256 KiB")
	}
	body, err := base64.StdEncoding.DecodeString(file.Content)
	if err != nil || len(body) != file.Size || !utf8.Valid(body) {
		return "", errors.New("invalid diagnostic source content")
	}
	return strings.ReplaceAll(string(body), r.token, "[redacted]"), nil
}
