package model

import (
	"errors"
	"regexp"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

var (
	ErrAgentModelRelayNonceInvalid = errors.New("invalid agent model relay nonce")
	ErrAgentModelRelayReplay       = errors.New("agent model relay request replayed")
	agentModelRelayNoncePattern    = regexp.MustCompile(`^[0-9a-f]{32}$`)
)

// AgentModelRelayNonce makes signed model-relay requests single-use across all
// New API instances. The primary key is the nonce; expiry bounds table growth.
type AgentModelRelayNonce struct {
	Nonce     string    `gorm:"type:char(32);primaryKey"`
	ExpiresAt time.Time `gorm:"not null;index"`
	CreatedAt time.Time
}

func (AgentModelRelayNonce) TableName() string { return "agent_model_relay_nonces" }

// ClaimAgentModelRelayNonce atomically consumes a signed request nonce. A
// database uniqueness constraint, rather than process memory, protects a
// multi-instance deployment from accepting the same request twice.
func ClaimAgentModelRelayNonce(nonce string, expiresAt, now time.Time) error {
	if DB == nil || !agentModelRelayNoncePattern.MatchString(nonce) || !expiresAt.After(now) {
		return ErrAgentModelRelayNonceInvalid
	}
	return DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("expires_at <= ?", now).Delete(&AgentModelRelayNonce{}).Error; err != nil {
			return err
		}
		result := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&AgentModelRelayNonce{
			Nonce: nonce, ExpiresAt: expiresAt.UTC(), CreatedAt: now.UTC(),
		})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return ErrAgentModelRelayReplay
		}
		return nil
	})
}
