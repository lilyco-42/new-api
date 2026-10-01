package model

import (
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

const dshRequestOne = "123e4567-e89b-42d3-a456-426614174000"
const dshRequestTwo = "123e4567-e89b-42d3-a456-426614174001"

func TestOwnedDSHCancellationPrecedesAdmissionAndStaysMonotonic(t *testing.T) {
	setupAgentDSHSessionModelTest(t)
	now := time.Date(2026, 10, 2, 0, 0, 0, 0, time.UTC)
	session, err := CreateAgentDSHSession(7, now)
	require.NoError(t, err)
	stopped, err := RequestOwnedAgentDSHCancellation(7, session.SessionId, strings.ToUpper(dshRequestOne), now)
	require.NoError(t, err)
	assert.True(t, stopped.CancelRequested)
	assert.Equal(t, dshRequestOne, stopped.RequestId)
	require.NotNil(t, stopped.CancelRequestedAt)
	assert.True(t, stopped.CancelRequestedAt.Equal(now))

	admission, err := ReserveOwnedAgentDSHRequest(7, session.SessionId, dshRequestOne, now.Add(time.Hour))
	require.NoError(t, err)
	assert.Equal(t, stopped.Id, admission.Id)
	assert.True(t, admission.CancelRequested)
	repeated, err := RequestOwnedAgentDSHCancellation(7, session.SessionId, dshRequestOne, now.Add(2*time.Hour))
	require.NoError(t, err)
	require.NotNil(t, repeated.CancelRequestedAt)
	assert.True(t, repeated.CancelRequestedAt.Equal(now))
	other, err := ReserveOwnedAgentDSHRequest(7, session.SessionId, dshRequestTwo, now)
	require.NoError(t, err)
	assert.False(t, other.CancelRequested)
	assert.Nil(t, other.CancelRequestedAt)
	owned, err := GetOwnedAgentDSHSession(7, session.SessionId)
	require.NoError(t, err)
	assert.Equal(t, 2, owned.RequestCount)
	var count int64
	require.NoError(t, DB.Model(&AgentDSHRequest{}).Count(&count).Error)
	assert.EqualValues(t, 2, count)
}

func TestOwnedDSHRequestsDenyOtherAccountsAndKeepSessionsIndependent(t *testing.T) {
	setupAgentDSHSessionModelTest(t)
	one, err := CreateAgentDSHSession(7, time.Time{})
	require.NoError(t, err)
	two, err := CreateAgentDSHSession(8, time.Time{})
	require.NoError(t, err)
	for _, cancel := range []bool{false, true} {
		_, err := accessOwnedAgentDSHRequest(8, one.SessionId, dshRequestOne, time.Time{}, cancel)
		assert.ErrorIs(t, err, ErrAgentDSHSessionNotFound)
	}
	_, err = RequestOwnedAgentDSHCancellation(7, one.SessionId, dshRequestOne, time.Time{})
	require.NoError(t, err)
	other, err := ReserveOwnedAgentDSHRequest(8, two.SessionId, dshRequestOne, time.Time{})
	require.NoError(t, err)
	assert.False(t, other.CancelRequested)
	_, err = ReserveOwnedAgentDSHRequest(7, one.SessionId, "not-a-request-id", time.Time{})
	assert.ErrorIs(t, err, ErrAgentDSHRequestInvalid)
	_, err = RequestOwnedAgentDSHCancellation(0, one.SessionId, dshRequestOne, time.Time{})
	assert.ErrorIs(t, err, ErrAgentDSHSessionNotFound)
}

func TestOwnedDSHRequestCapacityDoesNotPreventStoppingReservedWork(t *testing.T) {
	setupAgentDSHSessionModelTest(t)
	session, err := CreateAgentDSHSession(7, time.Time{})
	require.NoError(t, err)
	require.NoError(t, DB.Model(session).UpdateColumn("request_count", AgentDSHSessionRequestLimit-1).Error)
	_, err = ReserveOwnedAgentDSHRequest(7, session.SessionId, dshRequestOne, time.Time{})
	require.NoError(t, err)
	_, err = ReserveOwnedAgentDSHRequest(7, session.SessionId, dshRequestTwo, time.Time{})
	assert.ErrorIs(t, err, ErrAgentDSHRequestLimit)
	_, err = RequestOwnedAgentDSHCancellation(7, session.SessionId, dshRequestTwo, time.Time{})
	assert.ErrorIs(t, err, ErrAgentDSHRequestLimit)
	stopped, err := RequestOwnedAgentDSHCancellation(7, session.SessionId, dshRequestOne, time.Time{})
	require.NoError(t, err)
	assert.True(t, stopped.CancelRequested)
	owned, err := GetOwnedAgentDSHSession(7, session.SessionId)
	require.NoError(t, err)
	assert.Equal(t, AgentDSHSessionRequestLimit, owned.RequestCount)
}

func TestOwnedDSHReservationRollsBackItsSlotWhenPersistenceFails(t *testing.T) {
	setupAgentDSHSessionModelTest(t)
	session, err := CreateAgentDSHSession(7, time.Time{})
	require.NoError(t, err)
	failure := errors.New("request storage unavailable")
	require.NoError(t, DB.Callback().Create().Before("gorm:create").Register("test:dsh-request-failure", func(tx *gorm.DB) {
		if tx.Statement.Table == "agent_dsh_requests" {
			tx.AddError(failure)
		}
	}))
	_, err = ReserveOwnedAgentDSHRequest(7, session.SessionId, dshRequestOne, time.Time{})
	assert.ErrorIs(t, err, failure)
	owned, err := GetOwnedAgentDSHSession(7, session.SessionId)
	require.NoError(t, err)
	assert.Zero(t, owned.RequestCount)
	require.NoError(t, DB.Callback().Create().Remove("test:dsh-request-failure"))
	_, err = ReserveOwnedAgentDSHRequest(7, session.SessionId, dshRequestOne, time.Time{})
	require.NoError(t, err)
}

func TestOwnedDSHConcurrentReservationsAndStopUseOneDurableIdentity(t *testing.T) {
	setupAgentDSHSessionModelTest(t)
	session, err := CreateAgentDSHSession(7, time.Time{})
	require.NoError(t, err)
	const clients = 16
	results := make(chan error, clients)
	var group sync.WaitGroup
	for index := 0; index < clients; index++ {
		group.Add(1)
		go func(cancel bool) {
			defer group.Done()
			_, err := accessOwnedAgentDSHRequest(7, session.SessionId, dshRequestOne, time.Time{}, cancel)
			results <- err
		}(index == 0)
	}
	group.Wait()
	close(results)
	for err := range results {
		require.NoError(t, err)
	}
	request, err := ReserveOwnedAgentDSHRequest(7, session.SessionId, dshRequestOne, time.Time{})
	require.NoError(t, err)
	assert.True(t, request.CancelRequested)
	owned, err := GetOwnedAgentDSHSession(7, session.SessionId)
	require.NoError(t, err)
	assert.Equal(t, 1, owned.RequestCount)
}

func TestOwnedDSHCancellationSurvivesReopeningPersistentStorage(t *testing.T) {
	previousDB := DB
	t.Cleanup(func() { DB = previousDB })
	path := filepath.Join(t.TempDir(), "agent-requests.db")
	open := func() *gorm.DB {
		db, err := gorm.Open(sqlite.Open(path), &gorm.Config{})
		require.NoError(t, err)
		sqlDB, err := db.DB()
		require.NoError(t, err)
		sqlDB.SetMaxOpenConns(1)
		t.Cleanup(func() { _ = sqlDB.Close() })
		return db
	}
	DB = open()
	require.NoError(t, DB.AutoMigrate(&AgentDSHSession{}, &AgentDSHRequest{}))
	session, err := CreateAgentDSHSession(7, time.Time{})
	require.NoError(t, err)
	stopped, err := RequestOwnedAgentDSHCancellation(7, session.SessionId, dshRequestOne, time.Time{})
	require.NoError(t, err)
	sqlDB, err := DB.DB()
	require.NoError(t, err)
	require.NoError(t, sqlDB.Close())
	DB = open()
	request, err := ReserveOwnedAgentDSHRequest(7, session.SessionId, dshRequestOne, time.Time{})
	require.NoError(t, err)
	assert.True(t, request.CancelRequested)
	assert.Equal(t, stopped.Id, request.Id)
	assert.Equal(t, stopped.CancelRequestedAt, request.CancelRequestedAt)
	_, err = RequestOwnedAgentDSHCancellation(8, session.SessionId, dshRequestOne, time.Time{})
	assert.ErrorIs(t, err, ErrAgentDSHSessionNotFound)
}
