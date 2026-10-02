package service

import (
	"context"
	"os"
	"strconv"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/stretchr/testify/require"
)

// Explicit manual Actions evaluation only. No production account credential or
// deployment: Actions provides a read-only token for this public fork's evidence.
func TestAgentWorkflowEvidenceLiveRead(t *testing.T) {
	if os.Getenv("LAIN42_WORKFLOW_LIVE_EVALUATION") != "1" {
		t.Skip("manual live evidence evaluation only")
	}
	token := os.Getenv("LAIN42_WORKFLOW_READ_TOKEN")
	file := os.Getenv("LAIN42_WORKFLOW_EVIDENCE_FILE")
	runID, err := strconv.ParseInt(os.Getenv("LAIN42_WORKFLOW_RUN_ID"), 10, 64)
	require.NoError(t, err)
	require.NotEmpty(t, token)
	require.NotEmpty(t, file)
	evidence, err := ReadAgentWorkflowEvidence(context.Background(), "lilyco-42/new-api", runID, token)
	require.NoError(t, err)
	require.NotNil(t, evidence.Run)
	require.Equal(t, runID, evidence.Run.ID)
	require.NotNil(t, evidence.Workflow, "the real workflow at the failing commit must be read")
	logs := 0
	for _, job := range evidence.Jobs {
		if job.Log != "" {
			logs++
		}
	}
	require.Greater(t, logs, 0, "a balance, run status or empty log is not execution evidence")
	body, err := common.Marshal(evidence)
	require.NoError(t, err)
	require.NotContains(t, string(body), token)
	require.NoError(t, os.WriteFile(file, body, 0600))
}
