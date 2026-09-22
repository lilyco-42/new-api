package model

import (
	"errors"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
)

const (
	AgentRunEventTypeToolRequested   = "tool_requested"
	AgentRunEventTypeToolSucceeded   = "tool_succeeded"
	AgentRunEventTypeToolFailed      = "tool_failed"
	AgentRunEventTypeToolInterrupted = "tool_interrupted"
	AgentRunEventMaxRequestID        = 128
	AgentRunEventMaxOperation        = 128
	AgentRunEventMaxErrorCode        = 64
	AgentRunEventMaxPageSize         = 100
	// AgentRunEventRetention bounds the reconnect journal. It is deliberately
	// long enough for a user to recover from an offline node, while preventing
	// a decade of tool metadata from becoming an unbounded table.
	AgentRunEventRetention = 30 * 24 * time.Hour
)

var ErrAgentRunEventInvalid = errors.New("invalid agent run event")

// AgentRunEvent is a privacy-preserving journal for bridge tool requests.
// Payloads and errors are deliberately not persisted: only bounded metadata
// and keyed digests remain, so a reconnect can learn whether a request was
// completed without turning the database into a copy of model/tool output.
type AgentRunEvent struct {
	ID           int64     `json:"event_id" gorm:"primaryKey;autoIncrement"`
	UserId       int       `json:"-" gorm:"not null;index"`
	DeviceId     int64     `json:"device_id" gorm:"not null;index"`
	RequestId    string    `json:"request_id" gorm:"type:varchar(128);not null;index"`
	EventType    string    `json:"type" gorm:"type:varchar(32);not null;index"`
	Operation    string    `json:"operation" gorm:"type:varchar(128);not null"`
	InputDigest  string    `json:"input_digest,omitempty" gorm:"type:char(64)"`
	OutputDigest string    `json:"output_digest,omitempty" gorm:"type:char(64)"`
	ErrorCode    string    `json:"error_code,omitempty" gorm:"type:varchar(64)"`
	CreatedAt    time.Time `json:"created_at" gorm:"index"`
}

func (AgentRunEvent) TableName() string { return "agent_run_events" }

type AgentRunEventInput struct {
	UserId       int
	DeviceId     int64
	RequestId    string
	EventType    string
	Operation    string
	InputDigest  string
	OutputDigest string
	ErrorCode    string
	CreatedAt    time.Time
}

// AgentRunEventDigest creates a stable, non-reversible digest for an opaque
// request or result. It is keyed so the digest cannot be used as a general
// purpose hash oracle outside this installation.
func AgentRunEventDigest(payload []byte) string {
	if len(payload) == 0 {
		return ""
	}
	return common.GenerateHMACWithKey(
		[]byte("lain42-agent-event-v1:"+common.SessionSecret),
		string(payload),
	)
}

func validateAgentRunEventInput(input AgentRunEventInput) error {
	if input.UserId <= 0 || input.DeviceId <= 0 {
		return ErrAgentRunEventInvalid
	}
	if requestID := strings.TrimSpace(input.RequestId); requestID == "" || len(requestID) > AgentRunEventMaxRequestID {
		return ErrAgentRunEventInvalid
	}
	if operation := strings.TrimSpace(input.Operation); operation == "" || len(operation) > AgentRunEventMaxOperation {
		return ErrAgentRunEventInvalid
	}
	switch input.EventType {
	case AgentRunEventTypeToolRequested, AgentRunEventTypeToolSucceeded, AgentRunEventTypeToolFailed, AgentRunEventTypeToolInterrupted:
	default:
		return ErrAgentRunEventInvalid
	}
	if len(input.InputDigest) > 64 || len(input.OutputDigest) > 64 || len(input.ErrorCode) > AgentRunEventMaxErrorCode {
		return ErrAgentRunEventInvalid
	}
	return nil
}

// AppendAgentRunEvent persists only the event metadata. A nil DB is accepted
// for isolated bridge unit tests and local builds that have no database.
func AppendAgentRunEvent(input AgentRunEventInput) (*AgentRunEvent, error) {
	if err := validateAgentRunEventInput(input); err != nil {
		return nil, err
	}
	if DB == nil {
		return nil, nil
	}
	createdAt := input.CreatedAt
	if createdAt.IsZero() {
		createdAt = time.Now().UTC()
	}
	event := &AgentRunEvent{
		UserId:       input.UserId,
		DeviceId:     input.DeviceId,
		RequestId:    strings.TrimSpace(input.RequestId),
		EventType:    input.EventType,
		Operation:    strings.TrimSpace(input.Operation),
		InputDigest:  input.InputDigest,
		OutputDigest: input.OutputDigest,
		ErrorCode:    strings.TrimSpace(input.ErrorCode),
		CreatedAt:    createdAt,
	}
	if err := DB.Create(event).Error; err != nil {
		return nil, err
	}
	// Cleanup is best effort and sampled by the monotonically increasing id so
	// normal tool execution does not pay a delete query for every event.
	if event.ID > 0 && event.ID%128 == 0 {
		_ = DB.Where("created_at < ?", createdAt.Add(-AgentRunEventRetention)).Delete(&AgentRunEvent{}).Error
	}
	return event, nil
}

// ListAgentRunEvents returns events in ascending event-id order. Event IDs
// are the database cursor, so clients can resume with afterEventID without
// relying on wall-clock ordering across database replicas.
func ListAgentRunEvents(userID int, deviceID, afterEventID int64, limit int) ([]AgentRunEvent, error) {
	if userID <= 0 || deviceID < 0 || afterEventID < 0 {
		return nil, ErrAgentRunEventInvalid
	}
	if limit <= 0 || limit > AgentRunEventMaxPageSize {
		limit = AgentRunEventMaxPageSize
	}
	if DB == nil {
		return []AgentRunEvent{}, nil
	}
	query := DB.Where("user_id = ? AND id > ?", userID, afterEventID)
	if deviceID > 0 {
		query = query.Where("device_id = ?", deviceID)
	}
	events := make([]AgentRunEvent, 0, limit)
	if err := query.Order("id asc").Limit(limit).Find(&events).Error; err != nil {
		return nil, err
	}
	return events, nil
}
