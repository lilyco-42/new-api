package model

import (
	"errors"
	"regexp"
	"strings"
	"time"

	"gorm.io/gorm"
)

// AgentDSHSessionRequestLimit bounds durable request identities in one chat.
// Admission reserves a slot so Stop can always update an already reserved request.
const AgentDSHSessionRequestLimit = 1024

const AgentDSHRequestIDPattern = `^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`

var (
	ErrAgentDSHRequestInvalid = errors.New("agent DSH request identity is invalid")
	ErrAgentDSHRequestLimit   = errors.New("agent DSH session request limit reached")
	agentDSHRequestIDPattern  = regexp.MustCompile(AgentDSHRequestIDPattern)
)

// AgentDSHRequest stores account-owned admission and monotonic cancellation
// intent, without prompt text, attachments, model keys, or browser credentials.
// Records remain for the session lifetime: dropping a cancellation record
// would let an old request identity start again after a restart.
type AgentDSHRequest struct {
	Id                int64      `json:"-" gorm:"primaryKey"`
	UserId            int        `json:"-" gorm:"not null;index"`
	SessionId         string     `json:"-" gorm:"type:char(64);not null;uniqueIndex:idx_agent_dsh_request,priority:1"`
	RequestId         string     `json:"request_id" gorm:"type:char(36);not null;uniqueIndex:idx_agent_dsh_request,priority:2"`
	CancelRequested   bool       `json:"cancel_requested" gorm:"not null;default:false"`
	CreatedAt         time.Time  `json:"created_at"`
	CancelRequestedAt *time.Time `json:"cancel_requested_at,omitempty"`
}

func (AgentDSHRequest) TableName() string { return "agent_dsh_requests" }

// ReserveOwnedAgentDSHRequest idempotently reserves the identity before forwarding
// a turn. Callers must not forward when CancelRequested is true.
func ReserveOwnedAgentDSHRequest(userID int, sessionID, requestID string, now time.Time) (*AgentDSHRequest, error) {
	return accessOwnedAgentDSHRequest(userID, sessionID, requestID, now, false)
}

// RequestOwnedAgentDSHCancellation durably records intent even before admission.
// It does not claim that a forwarded model or tool task has stopped.
func RequestOwnedAgentDSHCancellation(userID int, sessionID, requestID string, now time.Time) (*AgentDSHRequest, error) {
	return accessOwnedAgentDSHRequest(userID, sessionID, requestID, now, true)
}

func accessOwnedAgentDSHRequest(userID int, sessionID, requestID string, now time.Time, cancel bool) (*AgentDSHRequest, error) {
	if DB == nil || userID <= 0 || !agentDSHSessionIDPattern.MatchString(sessionID) {
		return nil, ErrAgentDSHSessionNotFound
	}
	requestID = strings.ToLower(requestID)
	if !agentDSHRequestIDPattern.MatchString(requestID) {
		return nil, ErrAgentDSHRequestInvalid
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	now = now.UTC()
	var request AgentDSHRequest
	err := DB.Transaction(func(tx *gorm.DB) error {
		// Lock the owning session, not an absent request row, to serialize first
		// reservations on PostgreSQL/MySQL. SQLite serializes the write transaction.
		var session AgentDSHSession
		err := lockForUpdate(tx).Select("id").
			Where("user_id = ? AND session_id = ?", userID, sessionID).First(&session).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return ErrAgentDSHSessionNotFound
		}
		if err != nil {
			return err
		}
		err = tx.Where("user_id = ? AND session_id = ? AND request_id = ?", userID, sessionID, requestID).
			First(&request).Error
		if err == nil {
			if cancel && !request.CancelRequested {
				if err = tx.Model(&AgentDSHRequest{}).Where("id = ? AND user_id = ?", request.Id, userID).
					Updates(map[string]interface{}{"cancel_requested": true, "cancel_requested_at": now}).Error; err != nil {
					return err
				}
				request.CancelRequested = true
				request.CancelRequestedAt = &now
			}
			return nil
		}
		if !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}
		reserved := tx.Model(&AgentDSHSession{}).
			Where("id = ? AND user_id = ? AND request_count < ?", session.Id, userID, AgentDSHSessionRequestLimit).
			UpdateColumn("request_count", gorm.Expr("request_count + 1"))
		if reserved.Error != nil {
			return reserved.Error
		}
		if reserved.RowsAffected != 1 {
			return ErrAgentDSHRequestLimit
		}
		request = AgentDSHRequest{UserId: userID, SessionId: sessionID, RequestId: requestID, CreatedAt: now, CancelRequested: cancel}
		if cancel {
			request.CancelRequestedAt = &now
		}
		return tx.Create(&request).Error
	})
	if err != nil {
		return nil, err
	}
	return &request, nil
}
