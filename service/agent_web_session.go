package service

import (
	"time"

	"github.com/QuantumNous/new-api/model"
)

const AgentWebSessionMaxPageSize = model.AgentWebSessionMaxPageSize

var ErrAgentWebSessionInvalid = model.ErrAgentWebSessionInvalid

func CreateAgentWebSession(userID int) (*model.AgentWebSession, error) {
	return model.CreateAgentWebSession(userID)
}

func ResolveAgentWebSession(userID int, publicSessionID string) (*model.AgentWebSession, error) {
	return model.ResolveAgentWebSession(userID, publicSessionID)
}

func ResolveAgentWebSessionForRelay(dshSessionID string) (*model.AgentWebSession, error) {
	return model.ResolveAgentWebSessionForRelay(dshSessionID)
}

func ListAgentWebSessions(userID, limit int) ([]model.AgentWebSession, error) {
	return model.ListAgentWebSessions(userID, limit)
}

func RevokeAgentWebSession(userID int, publicSessionID string) error {
	return model.RevokeAgentWebSession(userID, publicSessionID, time.Now().UTC())
}
