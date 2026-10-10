package dto

// AgentDSHTurnRequest is accepted only from an authenticated New API browser
// session. The DSH session id is checked against that account before relay.
type AgentDSHTurnRequest struct {
	SessionID string `json:"session_id"`
	RequestID string `json:"request_id"`
	// Model is mandatory so a user turn cannot inherit the DSH host's shared default.
	Model  string              `json:"model"`
	Mode   string              `json:"mode,omitempty"`
	Text   string              `json:"text"`
	Images []AgentDSHTurnImage `json:"images,omitempty"`
	// ToolScope can only narrow the shipped read-only tool surface. A required
	// scope uses wire version 3 so an older DSH peer cannot silently ignore it.
	ToolScope string `json:"tool_scope,omitempty"`
}

// AgentDSHTurnImage is a bounded browser image payload accepted only as part
// of an authenticated, owner-checked DSH turn.
type AgentDSHTurnImage struct {
	MediaType string `json:"mediaType"`
	Data      string `json:"data"`
}

// AgentDSHCancelRequest names the original message, never the currently active
// turn. Its account owner comes exclusively from the authenticated session.
type AgentDSHCancelRequest struct {
	SessionID string `json:"session_id"`
	RequestID string `json:"request_id"`
}

// AgentDSHToolRelayRequest is sent by the private DSH server. Its exact body
// bytes are covered by the server-to-server HMAC before this DTO is accepted.
type AgentDSHToolRelayRequest struct {
	Version   int    `json:"version"`
	SessionID string `json:"session_id"`
	// Version 2 binds execution to the exact account-owned admitted request.
	RequestID string         `json:"request_id,omitempty"`
	Tool      string         `json:"tool"`
	Arguments map[string]any `json:"arguments"`
}
