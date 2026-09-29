package dto

// AgentDSHTurnRequest is accepted only from an authenticated New API browser
// session. The DSH session id is checked against that account before relay.
type AgentDSHTurnRequest struct {
	SessionID string `json:"session_id"`
	RequestID string `json:"request_id"`
	Model     string `json:"model,omitempty"`
	Mode      string `json:"mode,omitempty"`
	Text      string `json:"text"`
}

// AgentDSHToolRelayRequest is sent by the private DSH server. Its exact body
// bytes are covered by the server-to-server HMAC before this DTO is accepted.
type AgentDSHToolRelayRequest struct {
	Version   int            `json:"version"`
	SessionID string         `json:"session_id"`
	Tool      string         `json:"tool"`
	Arguments map[string]any `json:"arguments"`
}
