package model

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"time"

	"gorm.io/gorm"
)

const AgentDSHSessionIDBytes = 32

var (
	ErrAgentDSHSessionInvalid  = errors.New("agent DSH session is invalid")
	ErrAgentDSHSessionNotFound = errors.New("agent DSH session not found")
	agentDSHSessionIDPattern   = regexp.MustCompile(`^[A-Za-z0-9]{64}$`)
)

// AgentDSHSession binds an opaque DSH session identifier to exactly one New
// API account. Possession of the identifier is never used as authorization;
// public requests must also authenticate as UserId and private relays must
// arrive with the configured server-to-server signature.
type AgentDSHSession struct {
	Id           int64     `json:"id" gorm:"primaryKey"`
	UserId       int       `json:"-" gorm:"not null;index:idx_agent_dsh_user_created,priority:1"`
	SessionId    string    `json:"session_id" gorm:"type:char(64);not null;uniqueIndex"`
	CreatedAt    time.Time `json:"created_at" gorm:"index:idx_agent_dsh_user_created,priority:2"`
	RequestCount int       `json:"-" gorm:"not null;default:0"`
}

func (AgentDSHSession) TableName() string { return "agent_dsh_sessions" }

func CreateAgentDSHSession(userID int, now time.Time) (*AgentDSHSession, error) {
	if DB == nil || userID <= 0 {
		return nil, ErrAgentDSHSessionInvalid
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	random := make([]byte, AgentDSHSessionIDBytes)
	if _, err := rand.Read(random); err != nil {
		return nil, fmt.Errorf("generate Agent DSH session id: %w", err)
	}
	session := &AgentDSHSession{
		UserId:    userID,
		SessionId: hex.EncodeToString(random),
		CreatedAt: now,
	}
	if err := DB.Create(session).Error; err != nil {
		return nil, err
	}
	return session, nil
}

// GetOwnedAgentDSHSession deliberately combines the opaque id and account id
// in one query so a caller cannot distinguish another account's session from
// a nonexistent session.
func GetOwnedAgentDSHSession(userID int, sessionID string) (*AgentDSHSession, error) {
	if DB == nil || userID <= 0 || !agentDSHSessionIDPattern.MatchString(sessionID) {
		return nil, ErrAgentDSHSessionNotFound
	}
	var session AgentDSHSession
	err := DB.Where("user_id = ? AND session_id = ?", userID, sessionID).First(&session).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, ErrAgentDSHSessionNotFound
	}
	if err != nil {
		return nil, err
	}
	return &session, nil
}

// GetAgentDSHSessionOwner resolves a DSH session for a signed internal relay.
// The returned user id must be used for all credential and billing decisions.
func GetAgentDSHSessionOwner(sessionID string) (int, error) {
	if DB == nil || !agentDSHSessionIDPattern.MatchString(sessionID) {
		return 0, ErrAgentDSHSessionNotFound
	}
	var session AgentDSHSession
	err := DB.Select("user_id").Where("session_id = ?", sessionID).First(&session).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return 0, ErrAgentDSHSessionNotFound
	}
	if err != nil {
		return 0, err
	}
	if session.UserId <= 0 {
		return 0, ErrAgentDSHSessionNotFound
	}
	return session.UserId, nil
}
