package service

import "github.com/QuantumNous/new-api/model"

const AgentRunEventMaxPageSize = model.AgentRunEventMaxPageSize

var ErrAgentRunEventInvalid = model.ErrAgentRunEventInvalid

func ListAgentRunEvents(userID int, deviceID, afterEventID int64, limit int) ([]model.AgentRunEvent, error) {
	return model.ListAgentRunEvents(userID, deviceID, afterEventID, limit)
}
