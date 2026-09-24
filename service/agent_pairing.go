package service

import (
	"errors"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/model"
)

var (
	ErrAgentPairingInvalid   = model.ErrAgentPairingInvalid
	ErrAgentPairingExpired   = model.ErrAgentPairingExpired
	ErrAgentPairingClaimed   = model.ErrAgentPairingClaimed
	ErrAgentPairingConfirmed = model.ErrAgentPairingConfirmed
	ErrAgentPairingConsumed  = model.ErrAgentPairingConsumed
	ErrAgentDeviceNotFound   = model.ErrAgentDeviceNotFound
)

type AgentPairingCreated struct {
	Id            int64     `json:"id"`
	PairingTicket string    `json:"pairing_ticket"`
	ExpiresAt     time.Time `json:"expires_at"`
}

type AgentPairingClaimed struct {
	Id                 int64     `json:"id"`
	ConfirmationTicket string    `json:"confirmation_ticket"`
	RedeemTicket       string    `json:"redeem_ticket"`
	DeviceName         string    `json:"device_name"`
	ExpiresAt          time.Time `json:"expires_at"`
}

type AgentDeviceCredential struct {
	Device     *model.AgentDevice `json:"device"`
	Credential string             `json:"credential"`
}

func CreateAgentPairing(userID int, replaceDeviceID int64) (*AgentPairingCreated, error) {
	ticket, pairing, err := model.CreateAgentPairing(userID, replaceDeviceID, time.Now().UTC())
	if err != nil {
		return nil, err
	}
	return &AgentPairingCreated{Id: pairing.Id, PairingTicket: ticket, ExpiresAt: pairing.ExpiresAt}, nil
}

func ClaimAgentPairing(pairingTicket, deviceName, publicKey string) (*AgentPairingClaimed, error) {
	if strings.TrimSpace(pairingTicket) == "" {
		return nil, ErrAgentPairingInvalid
	}
	confirmationTicket, redeemTicket, pairing, err := model.ClaimAgentPairing(pairingTicket, deviceName, publicKey, time.Now().UTC())
	if err != nil {
		return nil, err
	}
	return &AgentPairingClaimed{
		Id:                 pairing.Id,
		ConfirmationTicket: confirmationTicket,
		RedeemTicket:       redeemTicket,
		DeviceName:         pairing.DeviceName,
		ExpiresAt:          pairing.ExpiresAt,
	}, nil
}

func ConfirmAgentPairing(userID int, pairingID int64, confirmationTicket string) error {
	_, err := model.ConfirmAgentPairing(int64(userID), pairingID, confirmationTicket, time.Now().UTC())
	return err
}

func RedeemAgentPairing(pairingID int64, redeemTicket string) (*AgentDeviceCredential, error) {
	device, credential, err := model.RedeemAgentPairing(pairingID, redeemTicket, time.Now().UTC())
	if err != nil {
		return nil, err
	}
	return &AgentDeviceCredential{Device: device, Credential: credential}, nil
}

func ListAgentDevices(userID int) ([]model.AgentDevice, error) {
	return model.ListAgentDevices(userID)
}

func GetAgentDeviceByCredential(credential string) (*model.AgentDevice, error) {
	return model.GetAgentDeviceByCredential(credential)
}

func GetAgentDevice(userID int, deviceID int64) (*model.AgentDevice, error) {
	if userID <= 0 || deviceID <= 0 {
		return nil, ErrAgentDeviceNotFound
	}
	var device model.AgentDevice
	if err := model.DB.Where("id = ? AND user_id = ? AND revoked_at IS NULL", deviceID, userID).First(&device).Error; err != nil {
		return nil, ErrAgentDeviceNotFound
	}
	return &device, nil
}

func RevokeAgentDevice(userID int, deviceID int64) error {
	if _, err := GetAgentDevice(userID, deviceID); err != nil {
		return err
	}
	err := DefaultAgentBridgeHub().RevokeDevice(userID, deviceID, func() error {
		return model.RevokeAgentDevice(userID, deviceID, time.Now().UTC())
	})
	if errors.Is(err, ErrAgentBridgeUnauthorized) {
		return ErrAgentDeviceNotFound
	}
	return err
}

func IsAgentPairingClientError(err error) bool {
	return errors.Is(err, ErrAgentPairingInvalid) ||
		errors.Is(err, ErrAgentPairingExpired) ||
		errors.Is(err, ErrAgentPairingClaimed) ||
		errors.Is(err, ErrAgentPairingConfirmed) ||
		errors.Is(err, ErrAgentPairingConsumed) ||
		errors.Is(err, ErrAgentDeviceNotFound)
}
