package types

import (
	"net/http"
	"testing"
)

func TestConvertedErrorsKeepUpdatedMessage(t *testing.T) {
	for _, format := range []string{"openai", "claude"} {
		t.Run(format, func(t *testing.T) {
			var apiErr *NewAPIError
			if format == "openai" {
				apiErr = WithOpenAIError(OpenAIError{
					Message: "provider unavailable",
					Type:    "server_error",
					Code:    "provider_down",
					Param:   "model",
				}, http.StatusBadGateway)
			} else {
				apiErr = WithClaudeError(ClaudeError{
					Message: "provider unavailable",
					Type:    "overloaded_error",
				}, http.StatusBadGateway)
			}
			message := "provider unavailable (request id: request-123)"
			apiErr.SetMessage(message)
			if got := apiErr.ToOpenAIError().Message; got != message {
				t.Fatalf("OpenAI response lost updated message: %q", got)
			}
			if got := apiErr.ToClaudeError().Message; got != message {
				t.Fatalf("Claude response lost updated message: %q", got)
			}
			if format == "openai" {
				converted := apiErr.ToOpenAIError()
				if converted.Type != "server_error" || converted.Code != "provider_down" || converted.Param != "model" {
					t.Fatalf("conversion changed provider error fields: %#v", converted)
				}
			}
		})
	}
}

func TestConvertedErrorsHonorHiddenMessage(t *testing.T) {
	apiErr := WithOpenAIError(OpenAIError{
		Message: "private provider diagnostic",
		Type:    "server_error",
	}, http.StatusBadGateway, ErrOptionWithHideErrMsg("provider request failed"))
	if got := apiErr.ToOpenAIError().Message; got != "provider request failed" {
		t.Fatalf("OpenAI response ignored hidden-message override: %q", got)
	}
	if got := apiErr.ToClaudeError().Message; got != "provider request failed" {
		t.Fatalf("Claude response ignored hidden-message override: %q", got)
	}
}
