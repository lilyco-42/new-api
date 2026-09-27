package model

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func setupAgentWebSessionModelTest(t *testing.T) {
	t.Helper()
	previousDB := DB
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	sqlDB, err := db.DB()
	require.NoError(t, err)
	sqlDB.SetMaxOpenConns(1)
	DB = db
	require.NoError(t, DB.AutoMigrate(&AgentWebSession{}))
	t.Cleanup(func() {
		DB = previousDB
		_ = sqlDB.Close()
	})
}

func TestAgentWebSessionsAreIsolatedAndHideDshIdentifiers(t *testing.T) {
	setupAgentWebSessionModelTest(t)
	userSeven, err := CreateAgentWebSession(7)
	require.NoError(t, err)
	userEight, err := CreateAgentWebSession(8)
	require.NoError(t, err)
	require.Len(t, userSeven.PublicSessionId, 64)
	require.Len(t, userSeven.DshSessionId, 64)
	require.NotEqual(t, userSeven.PublicSessionId, userSeven.DshSessionId)
	require.NotEqual(t, userSeven.PublicSessionId, userEight.PublicSessionId)

	resolved, err := ResolveAgentWebSession(7, userSeven.PublicSessionId)
	require.NoError(t, err)
	require.Equal(t, userSeven.DshSessionId, resolved.DshSessionId)
	_, err = ResolveAgentWebSession(7, userEight.PublicSessionId)
	require.ErrorIs(t, err, gorm.ErrRecordNotFound)
	_, err = ResolveAgentWebSession(8, userSeven.PublicSessionId)
	require.ErrorIs(t, err, gorm.ErrRecordNotFound)

	listed, err := ListAgentWebSessions(7, 1000)
	require.NoError(t, err)
	require.Len(t, listed, 1)
	require.Equal(t, userSeven.PublicSessionId, listed[0].PublicSessionId)

	serialized, err := json.Marshal(userSeven)
	require.NoError(t, err)
	require.NotContains(t, string(serialized), userSeven.DshSessionId)
	require.NotContains(t, string(serialized), "user_id")
}

func TestRevokedAgentWebSessionCannotBeResolvedOrRevokedCrossAccount(t *testing.T) {
	setupAgentWebSessionModelTest(t)
	session, err := CreateAgentWebSession(7)
	require.NoError(t, err)
	now := time.Unix(1234, 0).UTC()
	require.ErrorIs(t, RevokeAgentWebSession(8, session.PublicSessionId, now), gorm.ErrRecordNotFound)
	_, err = ResolveAgentWebSession(7, session.PublicSessionId)
	require.NoError(t, err)
	require.NoError(t, RevokeAgentWebSession(7, session.PublicSessionId, now))
	require.NoError(t, RevokeAgentWebSession(7, session.PublicSessionId, now.Add(time.Second)))
	_, err = ResolveAgentWebSession(7, session.PublicSessionId)
	require.ErrorIs(t, err, gorm.ErrRecordNotFound)

	var persisted AgentWebSession
	require.NoError(t, DB.Where("public_session_id = ?", session.PublicSessionId).First(&persisted).Error)
	require.Equal(t, AgentWebSessionStatusRevoked, persisted.Status)
	require.Equal(t, now, *persisted.RevokedAt)
}

func TestAgentWebSessionRejectsInvalidIdentity(t *testing.T) {
	setupAgentWebSessionModelTest(t)
	_, err := CreateAgentWebSession(0)
	require.ErrorIs(t, err, ErrAgentWebSessionInvalid)
	_, err = ResolveAgentWebSession(7, "short")
	require.ErrorIs(t, err, ErrAgentWebSessionInvalid)
	require.ErrorIs(t, RevokeAgentWebSession(7, "short", time.Time{}), ErrAgentWebSessionInvalid)
	_, err = ListAgentWebSessions(0, 10)
	require.ErrorIs(t, err, ErrAgentWebSessionInvalid)
}
