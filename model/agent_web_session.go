package model

import (
	"errors"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"gorm.io/gorm"
)

const (
	AgentWebSessionStatusActive  = "active"
	AgentWebSessionStatusRevoked = "revoked"
	AgentWebSessionMaxPageSize   = 50
)

var ErrAgentWebSessionInvalid = errors.New("invalid agent web session")

// AgentWebSession maps an opaque browser-visible identifier to an internal
// DSH session. The DSH identifier is never serialized to the browser. Every
// lookup is scoped to the authenticated Lain42 user, not to a client-provided
// owner, workspace, or filesystem path.
type AgentWebSession struct {
	ID              int64      `json:"-" gorm:"primaryKey;autoIncrement"`
	UserId          int        `json:"-" gorm:"not null;index:idx_agent_web_session_user_public,unique"`
	PublicSessionId string     `json:"session_id" gorm:"type:varchar(64);not null;uniqueIndex"`
	DshSessionId    string     `json:"-" gorm:"type:varchar(64);not null;uniqueIndex"`
	Status          string     `json:"status" gorm:"type:varchar(16);not null;index"`
	CreatedAt       time.Time  `json:"created_at"`
	UpdatedAt       time.Time  `json:"updated_at"`
	RevokedAt       *time.Time `json:"revoked_at,omitempty" gorm:"index"`
}

func (AgentWebSession) TableName() string { return "agent_web_sessions" }

// CreateAgentWebSession creates both identifiers on the server. Callers must
// not accept either identifier or a user identity from an untrusted client.
func CreateAgentWebSession(userID int) (*AgentWebSession, error) {
	if userID <= 0 || DB == nil {
		return nil, ErrAgentWebSessionInvalid
	}
	publicID, err := common.GenerateRandomCharsKey(64)
	if err != nil {
		return nil, err
	}
	dshID, err := common.GenerateRandomCharsKey(64)
	if err != nil {
		return nil, err
	}
	now := time.Now().UTC()
	session := &AgentWebSession{
		UserId:          userID,
		PublicSessionId: publicID,
		DshSessionId:    dshID,
		Status:          AgentWebSessionStatusActive,
		CreatedAt:       now,
		UpdatedAt:       now,
	}
	if err := DB.Create(session).Error; err != nil {
		return nil, err
	}
	return session, nil
}

// ResolveAgentWebSession returns only an active session owned by userID.
// Cross-account and revoked identifiers are indistinguishable from missing
// sessions to avoid leaking whether another user's session exists.
func ResolveAgentWebSession(userID int, publicSessionID string) (*AgentWebSession, error) {
	publicSessionID = strings.TrimSpace(publicSessionID)
	if userID <= 0 || len(publicSessionID) != 64 || DB == nil {
		return nil, ErrAgentWebSessionInvalid
	}
	var session AgentWebSession
	if err := DB.Where(
		"user_id = ? AND public_session_id = ? AND status = ?",
		userID,
		publicSessionID,
		AgentWebSessionStatusActive,
	).First(&session).Error; err != nil {
		return nil, err
	}
	return &session, nil
}

// ListAgentWebSessions returns only the caller's active sessions.
func ListAgentWebSessions(userID, limit int) ([]AgentWebSession, error) {
	if userID <= 0 || DB == nil {
		return nil, ErrAgentWebSessionInvalid
	}
	if limit <= 0 || limit > AgentWebSessionMaxPageSize {
		limit = AgentWebSessionMaxPageSize
	}
	sessions := make([]AgentWebSession, 0, limit)
	err := DB.Where("user_id = ? AND status = ?", userID, AgentWebSessionStatusActive).
		Order("updated_at desc, id desc").Limit(limit).Find(&sessions).Error
	return sessions, err
}

// RevokeAgentWebSession is idempotent for an owned session and never changes
// another user's session.
func RevokeAgentWebSession(userID int, publicSessionID string, now time.Time) error {
	publicSessionID = strings.TrimSpace(publicSessionID)
	if userID <= 0 || len(publicSessionID) != 64 || DB == nil {
		return ErrAgentWebSessionInvalid
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	result := DB.Model(&AgentWebSession{}).
		Where("user_id = ? AND public_session_id = ? AND status = ?", userID, publicSessionID, AgentWebSessionStatusActive).
		Updates(map[string]any{
			"status":     AgentWebSessionStatusRevoked,
			"revoked_at": now,
			"updated_at": now,
		})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected > 0 {
		return nil
	}
	var existing AgentWebSession
	if err := DB.Where("user_id = ? AND public_session_id = ?", userID, publicSessionID).First(&existing).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return gorm.ErrRecordNotFound
		}
		return err
	}
	return nil
}
