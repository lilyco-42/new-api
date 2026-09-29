package model

import (
	"testing"
	"time"

	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func setupAgentDSHSessionModelTest(t *testing.T) {
	t.Helper()
	previousDB := DB
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	sqlDB, err := db.DB()
	require.NoError(t, err)
	sqlDB.SetMaxOpenConns(1)
	DB = db
	require.NoError(t, DB.AutoMigrate(&AgentDSHSession{}))
	t.Cleanup(func() {
		DB = previousDB
		_ = sqlDB.Close()
	})
}

func TestAgentDSHSessionsAreOpaqueAndAccountScoped(t *testing.T) {
	setupAgentDSHSessionModelTest(t)
	now := time.Date(2026, time.September, 29, 0, 0, 0, 0, time.UTC)
	userOne, err := CreateAgentDSHSession(7, now)
	require.NoError(t, err)
	userTwo, err := CreateAgentDSHSession(8, now)
	require.NoError(t, err)

	assert.Len(t, userOne.SessionId, AgentDSHSessionIDBytes*2)
	assert.NotEqual(t, userOne.SessionId, userTwo.SessionId)
	assert.Equal(t, 7, userOne.UserId)
	assert.Equal(t, 8, userTwo.UserId)

	owned, err := GetOwnedAgentDSHSession(7, userOne.SessionId)
	require.NoError(t, err)
	assert.Equal(t, userOne.Id, owned.Id)

	_, err = GetOwnedAgentDSHSession(8, userOne.SessionId)
	assert.ErrorIs(t, err, ErrAgentDSHSessionNotFound)

	ownerID, err := GetAgentDSHSessionOwner(userTwo.SessionId)
	require.NoError(t, err)
	assert.Equal(t, 8, ownerID)
}

func TestAgentDSHSessionRejectsMalformedOrUnownedIDs(t *testing.T) {
	setupAgentDSHSessionModelTest(t)
	_, err := GetOwnedAgentDSHSession(7, "too-short")
	assert.ErrorIs(t, err, ErrAgentDSHSessionNotFound)
	_, err = GetAgentDSHSessionOwner("too-short")
	assert.ErrorIs(t, err, ErrAgentDSHSessionNotFound)
	_, err = GetAgentDSHSessionOwner("ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ")
	assert.ErrorIs(t, err, ErrAgentDSHSessionNotFound)
}
