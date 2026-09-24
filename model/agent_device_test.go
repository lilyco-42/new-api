package model

import (
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func setupAgentDeviceModelTest(t *testing.T) {
	t.Helper()
	previousDB := DB
	previousSessionSecret := common.SessionSecret
	common.SessionSecret = "agent-device-model-test-secret"
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	sqlDB, err := db.DB()
	require.NoError(t, err)
	sqlDB.SetMaxOpenConns(1)
	DB = db
	require.NoError(t, DB.AutoMigrate(&AgentPairing{}, &AgentDevice{}))
	t.Cleanup(func() {
		DB = previousDB
		common.SessionSecret = previousSessionSecret
		_ = sqlDB.Close()
	})
}

func TestCreateAgentPairingScopesReplacementToTheCurrentUser(t *testing.T) {
	setupAgentDeviceModelTest(t)
	device := AgentDevice{
		UserId:          7,
		DeviceName:      "radxa-a7a",
		DevicePublicKey: "radxa-a7a-device",
		CredentialHash:  agentSecretHash("credential", "existing-credential"),
		CreatedAt:       time.Unix(100, 0).UTC(),
	}
	require.NoError(t, DB.Create(&device).Error)

	_, _, err := CreateAgentPairing(8, device.Id, time.Unix(200, 0).UTC())
	require.ErrorIs(t, err, ErrAgentDeviceNotFound)

	_, pairing, err := CreateAgentPairing(7, device.Id, time.Unix(200, 0).UTC())
	require.NoError(t, err)
	require.NotNil(t, pairing.ReplaceDeviceID)
	require.Equal(t, device.Id, *pairing.ReplaceDeviceID)
}

func TestListAgentDevicesOnlyReturnsTheRequestingUsersDevices(t *testing.T) {
	setupAgentDeviceModelTest(t)
	devices := []AgentDevice{
		{
			UserId:          7,
			DeviceName:      "user-7-device",
			DevicePublicKey: "user-7-key",
			CredentialHash:  agentSecretHash("credential", "user-7-credential"),
			CreatedAt:       time.Unix(100, 0).UTC(),
		},
		{
			UserId:          8,
			DeviceName:      "user-8-device",
			DevicePublicKey: "user-8-key",
			CredentialHash:  agentSecretHash("credential", "user-8-credential"),
			CreatedAt:       time.Unix(200, 0).UTC(),
		},
	}
	for index := range devices {
		require.NoError(t, DB.Create(&devices[index]).Error)
	}

	user7Devices, err := ListAgentDevices(7)
	require.NoError(t, err)
	require.Len(t, user7Devices, 1)
	require.Equal(t, devices[0].Id, user7Devices[0].Id)
	require.Equal(t, 7, user7Devices[0].UserId)

	user8Devices, err := ListAgentDevices(8)
	require.NoError(t, err)
	require.Len(t, user8Devices, 1)
	require.Equal(t, devices[1].Id, user8Devices[0].Id)
	require.Equal(t, 8, user8Devices[0].UserId)
}

func TestRedeemAgentPairingRotatesCredentialAndPreservesDeviceRecord(t *testing.T) {
	setupAgentDeviceModelTest(t)
	createdAt := time.Unix(100, 0).UTC()
	oldPairedAt := time.Unix(110, 0).UTC()
	device := AgentDevice{
		UserId:          7,
		DeviceName:      "radxa-a7a",
		DevicePublicKey: "legacy-node-name",
		CredentialHash:  agentSecretHash("credential", "old-credential"),
		CreatedAt:       createdAt,
		LastPairedAt:    &oldPairedAt,
	}
	require.NoError(t, DB.Create(&device).Error)

	otherPairedAt := time.Unix(200, 0).UTC()
	otherDevice := AgentDevice{
		UserId:          7,
		DeviceName:      "desktop",
		DevicePublicKey: "other-device",
		CredentialHash:  agentSecretHash("credential", "other-credential"),
		CreatedAt:       otherPairedAt,
		LastPairedAt:    &otherPairedAt,
	}
	require.NoError(t, DB.Create(&otherDevice).Error)

	repairedAt := time.Unix(300, 0).UTC()
	pairingTicket, pairing, err := CreateAgentPairing(7, device.Id, repairedAt)
	require.NoError(t, err)
	confirmationTicket, redeemTicket, claimed, err := ClaimAgentPairing(
		pairingTicket,
		"radxa-a7a",
		"radxa-a7a-radxa-cubie-a7a",
		repairedAt.Add(time.Second),
	)
	require.NoError(t, err)
	_, err = ConfirmAgentPairing(7, claimed.Id, confirmationTicket, repairedAt.Add(2*time.Second))
	require.NoError(t, err)

	redeemedDevice, newCredential, err := RedeemAgentPairing(claimed.Id, redeemTicket, repairedAt.Add(3*time.Second))
	require.NoError(t, err)
	require.NotEmpty(t, newCredential)
	require.NotEqual(t, "old-credential", newCredential)
	require.Equal(t, device.Id, redeemedDevice.Id)
	require.Equal(t, "radxa-a7a-radxa-cubie-a7a", redeemedDevice.DevicePublicKey)
	require.True(t, redeemedDevice.LastPairedAt.Equal(repairedAt.Add(3*time.Second)))
	require.Equal(t, pairing.Id, claimed.Id)

	_, err = GetAgentDeviceByCredential("old-credential")
	require.ErrorIs(t, err, ErrAgentDeviceNotFound)
	activeDevice, err := GetAgentDeviceByCredential(newCredential)
	require.NoError(t, err)
	require.Equal(t, device.Id, activeDevice.Id)

	devices, err := ListAgentDevices(7)
	require.NoError(t, err)
	require.Len(t, devices, 2, "re-pair must update the existing record instead of creating another")
	require.Equal(t, device.Id, devices[0].Id, "the repaired device should be listed by its latest pairing time")

	_, _, err = RedeemAgentPairing(claimed.Id, redeemTicket, repairedAt.Add(4*time.Second))
	require.ErrorIs(t, err, ErrAgentPairingConsumed)
}

func TestRedeemAgentPairingFailsIfReplacementWasRevoked(t *testing.T) {
	setupAgentDeviceModelTest(t)
	now := time.Unix(500, 0).UTC()
	device := AgentDevice{
		UserId:          7,
		DeviceName:      "radxa-a7a",
		DevicePublicKey: "node",
		CredentialHash:  agentSecretHash("credential", "existing-credential"),
		CreatedAt:       now,
	}
	require.NoError(t, DB.Create(&device).Error)
	pairingTicket, pairing, err := CreateAgentPairing(7, device.Id, now)
	require.NoError(t, err)
	confirmationTicket, redeemTicket, claimed, err := ClaimAgentPairing(pairingTicket, "radxa-a7a", "node", now.Add(time.Second))
	require.NoError(t, err)
	_, err = ConfirmAgentPairing(7, claimed.Id, confirmationTicket, now.Add(2*time.Second))
	require.NoError(t, err)
	require.NoError(t, RevokeAgentDevice(7, device.Id, now.Add(3*time.Second)))

	_, _, err = RedeemAgentPairing(claimed.Id, redeemTicket, now.Add(4*time.Second))
	require.ErrorIs(t, err, ErrAgentDeviceNotFound)
	var pairingAfterFailure AgentPairing
	require.NoError(t, DB.First(&pairingAfterFailure, pairing.Id).Error)
	require.Equal(t, AgentPairingStatusConfirmed, pairingAfterFailure.Status, "failed re-pair must not consume its one-time ticket")
}
