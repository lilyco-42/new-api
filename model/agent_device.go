package model

import (
	"errors"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"gorm.io/gorm"
)

const (
	AgentPairingStatusPending   = "pending"
	AgentPairingStatusClaimed   = "claimed"
	AgentPairingStatusConfirmed = "confirmed"
	AgentPairingStatusConsumed  = "consumed"
	AgentPairingTTL             = 5 * time.Minute
)

var (
	ErrAgentPairingInvalid   = errors.New("agent pairing is invalid")
	ErrAgentPairingExpired   = errors.New("agent pairing has expired")
	ErrAgentPairingClaimed   = errors.New("agent pairing has already been claimed")
	ErrAgentPairingConfirmed = errors.New("agent pairing has not been confirmed")
	ErrAgentPairingConsumed  = errors.New("agent pairing has already been consumed")
	ErrAgentDeviceNotFound   = errors.New("agent device not found")
)

// AgentPairing is the short-lived, one-time ceremony between a platform user
// and a desktop. Opaque tickets are never persisted; only HMAC summaries are.
type AgentPairing struct {
	Id               int64      `json:"id" gorm:"primaryKey"`
	UserId           int        `json:"user_id" gorm:"not null;index"`
	PairingHash      string     `json:"-" gorm:"type:char(64);not null;uniqueIndex"`
	ConfirmationHash *string    `json:"-" gorm:"type:char(64);uniqueIndex"`
	RedeemHash       *string    `json:"-" gorm:"type:char(64);uniqueIndex"`
	DeviceName       string     `json:"device_name" gorm:"type:varchar(128);not null"`
	DevicePublicKey  string     `json:"device_public_key" gorm:"type:text;not null"`
	ReplaceDeviceID  *int64     `json:"replace_device_id,omitempty" gorm:"index"`
	Status           string     `json:"status" gorm:"type:varchar(16);not null;index"`
	CreatedAt        time.Time  `json:"created_at"`
	ExpiresAt        time.Time  `json:"expires_at" gorm:"index"`
	ClaimedAt        *time.Time `json:"claimed_at,omitempty"`
	ConfirmedAt      *time.Time `json:"confirmed_at,omitempty"`
	ConsumedAt       *time.Time `json:"consumed_at,omitempty"`
}

// AgentDevice stores a user's device identity. The credential itself is
// returned only from RedeemAgentPairing and is represented here by a digest.
type AgentDevice struct {
	Id              int64      `json:"id" gorm:"primaryKey"`
	UserId          int        `json:"user_id" gorm:"not null;index"`
	DeviceName      string     `json:"device_name" gorm:"type:varchar(128);not null"`
	DevicePublicKey string     `json:"device_public_key" gorm:"type:text;not null"`
	CredentialHash  string     `json:"-" gorm:"type:char(64);not null;uniqueIndex"`
	CreatedAt       time.Time  `json:"created_at"`
	LastPairedAt    *time.Time `json:"last_paired_at,omitempty" gorm:"index"`
	RevokedAt       *time.Time `json:"revoked_at,omitempty" gorm:"index"`
}

func (AgentPairing) TableName() string { return "agent_pairings" }
func (AgentDevice) TableName() string  { return "agent_devices" }

func agentSecretHash(kind, value string) string {
	return common.GenerateHMACWithKey([]byte("lain42-agent-"+kind+"-v1:"+common.SessionSecret), value)
}

func CreateAgentPairing(userID int, replaceDeviceID int64, now time.Time) (string, *AgentPairing, error) {
	if userID <= 0 {
		return "", nil, ErrAgentPairingInvalid
	}
	if replaceDeviceID < 0 {
		return "", nil, ErrAgentPairingInvalid
	}
	if replaceDeviceID > 0 {
		var device AgentDevice
		if err := DB.Where("id = ? AND user_id = ? AND revoked_at IS NULL", replaceDeviceID, userID).First(&device).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return "", nil, ErrAgentDeviceNotFound
			}
			return "", nil, err
		}
	}
	pairingTicket, err := common.GenerateRandomCharsKey(64)
	if err != nil {
		return "", nil, err
	}
	var replaceID *int64
	if replaceDeviceID > 0 {
		replaceID = &replaceDeviceID
	}
	pairing := &AgentPairing{
		UserId:          userID,
		PairingHash:     agentSecretHash("pairing", pairingTicket),
		ReplaceDeviceID: replaceID,
		Status:          AgentPairingStatusPending,
		CreatedAt:       now,
		ExpiresAt:       now.Add(AgentPairingTTL),
	}
	if err := DB.Create(pairing).Error; err != nil {
		return "", nil, err
	}
	return pairingTicket, pairing, nil
}

// ClaimAgentPairing creates two distinct high-entropy tickets. The
// confirmation ticket may be delivered to the user's authenticated browser
// in memory; the redeem ticket stays on the desktop until redemption.
func ClaimAgentPairing(pairingTicket, deviceName, publicKey string, now time.Time) (string, string, *AgentPairing, error) {
	pairingTicket = strings.TrimSpace(pairingTicket)
	deviceName = strings.TrimSpace(deviceName)
	publicKey = strings.TrimSpace(publicKey)
	if pairingTicket == "" || deviceName == "" || publicKey == "" || len(deviceName) > 128 || len(publicKey) > 4096 {
		return "", "", nil, ErrAgentPairingInvalid
	}
	confirmationTicket, err := common.GenerateRandomCharsKey(64)
	if err != nil {
		return "", "", nil, err
	}
	redeemTicket, err := common.GenerateRandomCharsKey(64)
	if err != nil {
		return "", "", nil, err
	}
	var claimed AgentPairing
	err = DB.Transaction(func(tx *gorm.DB) error {
		if err := lockForUpdate(tx).Where("pairing_hash = ?", agentSecretHash("pairing", pairingTicket)).First(&claimed).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrAgentPairingInvalid
			}
			return err
		}
		if !claimed.ExpiresAt.After(now) {
			return ErrAgentPairingExpired
		}
		if claimed.Status != AgentPairingStatusPending {
			return ErrAgentPairingClaimed
		}
		confirmationHash := agentSecretHash("confirmation", confirmationTicket)
		redeemHash := agentSecretHash("redeem", redeemTicket)
		claimed.ConfirmationHash = &confirmationHash
		claimed.RedeemHash = &redeemHash
		claimed.DeviceName = deviceName
		claimed.DevicePublicKey = publicKey
		claimed.Status = AgentPairingStatusClaimed
		claimed.ClaimedAt = &now
		result := tx.Model(&AgentPairing{}).Where("id = ? AND status = ?", claimed.Id, AgentPairingStatusPending).Updates(map[string]any{
			"confirmation_hash": claimed.ConfirmationHash,
			"redeem_hash":       claimed.RedeemHash,
			"device_name":       claimed.DeviceName,
			"device_public_key": claimed.DevicePublicKey,
			"status":            claimed.Status,
			"claimed_at":        claimed.ClaimedAt,
		})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return ErrAgentPairingClaimed
		}
		return nil
	})
	if err != nil {
		return "", "", nil, err
	}
	return confirmationTicket, redeemTicket, &claimed, nil
}

func ConfirmAgentPairing(userID, pairingID int64, confirmationTicket string, now time.Time) (*AgentPairing, error) {
	if userID <= 0 || pairingID <= 0 || strings.TrimSpace(confirmationTicket) == "" {
		return nil, ErrAgentPairingInvalid
	}
	var pairing AgentPairing
	err := DB.Transaction(func(tx *gorm.DB) error {
		if err := lockForUpdate(tx).Where("id = ? AND user_id = ? AND confirmation_hash = ?", pairingID, userID, agentSecretHash("confirmation", strings.TrimSpace(confirmationTicket))).First(&pairing).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrAgentPairingInvalid
			}
			return err
		}
		if !pairing.ExpiresAt.After(now) {
			return ErrAgentPairingExpired
		}
		if pairing.Status != AgentPairingStatusClaimed {
			if pairing.Status == AgentPairingStatusConfirmed {
				return ErrAgentPairingClaimed
			}
			return ErrAgentPairingInvalid
		}
		pairing.Status = AgentPairingStatusConfirmed
		pairing.ConfirmedAt = &now
		result := tx.Model(&AgentPairing{}).Where("id = ? AND status = ?", pairing.Id, AgentPairingStatusClaimed).Updates(map[string]any{
			"status":       pairing.Status,
			"confirmed_at": pairing.ConfirmedAt,
		})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return ErrAgentPairingClaimed
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &pairing, nil
}

func RedeemAgentPairing(pairingID int64, redeemTicket string, now time.Time) (*AgentDevice, string, error) {
	if pairingID <= 0 || strings.TrimSpace(redeemTicket) == "" {
		return nil, "", ErrAgentPairingInvalid
	}
	credential, err := common.GenerateRandomCharsKey(80)
	if err != nil {
		return nil, "", err
	}
	var device AgentDevice
	err = DB.Transaction(func(tx *gorm.DB) error {
		var pairing AgentPairing
		if err := lockForUpdate(tx).Where("id = ? AND redeem_hash = ?", pairingID, agentSecretHash("redeem", strings.TrimSpace(redeemTicket))).First(&pairing).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrAgentPairingInvalid
			}
			return err
		}
		if !pairing.ExpiresAt.After(now) {
			return ErrAgentPairingExpired
		}
		if pairing.Status == AgentPairingStatusConsumed {
			return ErrAgentPairingConsumed
		}
		if pairing.Status != AgentPairingStatusConfirmed {
			return ErrAgentPairingConfirmed
		}
		credentialHash := agentSecretHash("credential", credential)
		if pairing.ReplaceDeviceID != nil {
			if err := lockForUpdate(tx).
				Where("id = ? AND user_id = ? AND revoked_at IS NULL", *pairing.ReplaceDeviceID, pairing.UserId).
				First(&device).Error; err != nil {
				if errors.Is(err, gorm.ErrRecordNotFound) {
					return ErrAgentDeviceNotFound
				}
				return err
			}
			result := tx.Model(&AgentDevice{}).
				Where("id = ? AND user_id = ? AND revoked_at IS NULL", device.Id, pairing.UserId).
				Updates(map[string]any{
					"device_name":       pairing.DeviceName,
					"device_public_key": pairing.DevicePublicKey,
					"credential_hash":   credentialHash,
					"last_paired_at":    now,
				})
			if result.Error != nil {
				return result.Error
			}
			if result.RowsAffected != 1 {
				return ErrAgentDeviceNotFound
			}
			device.DeviceName = pairing.DeviceName
			device.DevicePublicKey = pairing.DevicePublicKey
			device.CredentialHash = credentialHash
			device.LastPairedAt = &now
		} else {
			device = AgentDevice{
				UserId:          pairing.UserId,
				DeviceName:      pairing.DeviceName,
				DevicePublicKey: pairing.DevicePublicKey,
				CredentialHash:  credentialHash,
				CreatedAt:       now,
				LastPairedAt:    &now,
			}
			if err := tx.Create(&device).Error; err != nil {
				return err
			}
		}
		consumedAt := now
		result := tx.Model(&AgentPairing{}).Where("id = ? AND status = ?", pairing.Id, AgentPairingStatusConfirmed).Updates(map[string]any{
			"status":      AgentPairingStatusConsumed,
			"consumed_at": &consumedAt,
		})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return ErrAgentPairingConsumed
		}
		return nil
	})
	if err != nil {
		return nil, "", err
	}
	return &device, credential, nil
}

func ListAgentDevices(userID int) ([]AgentDevice, error) {
	if userID <= 0 {
		return nil, ErrAgentDeviceNotFound
	}
	var devices []AgentDevice
	if err := DB.Where("user_id = ?", userID).
		Order("COALESCE(last_paired_at, created_at) DESC").
		Order("id DESC").Find(&devices).Error; err != nil {
		return nil, err
	}
	return devices, nil
}

func RevokeAgentDevice(userID int, deviceID int64, now time.Time) error {
	if userID <= 0 || deviceID <= 0 {
		return ErrAgentDeviceNotFound
	}
	result := DB.Model(&AgentDevice{}).Where("id = ? AND user_id = ? AND revoked_at IS NULL", deviceID, userID).Updates(map[string]any{"revoked_at": &now})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return ErrAgentDeviceNotFound
	}
	return nil
}

func GetAgentDeviceByCredential(credential string) (*AgentDevice, error) {
	credential = strings.TrimSpace(credential)
	if credential == "" {
		return nil, ErrAgentDeviceNotFound
	}
	var device AgentDevice
	if err := DB.Where("credential_hash = ? AND revoked_at IS NULL", agentSecretHash("credential", credential)).First(&device).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrAgentDeviceNotFound
		}
		return nil, err
	}
	return &device, nil
}
