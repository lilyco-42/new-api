package model

import (
	"testing"
	"time"

	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func setupAgentRunEventModelTest(t *testing.T) {
	t.Helper()
	previousDB := DB
	DB = nil
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	DB = db
	require.NoError(t, DB.AutoMigrate(&AgentRunEvent{}))
	t.Cleanup(func() { DB = previousDB })
}

func TestAgentRunEventJournalIsBoundedAndCursorReadable(t *testing.T) {
	setupAgentRunEventModelTest(t)
	first, err := AppendAgentRunEvent(AgentRunEventInput{
		UserId:      7,
		DeviceId:    11,
		RequestId:   "request-1",
		EventType:   AgentRunEventTypeToolRequested,
		Operation:   "github.issues.list",
		InputDigest: AgentRunEventDigest([]byte(`{"repo":"owner/name"}`)),
		CreatedAt:   time.Unix(10, 0).UTC(),
	})
	require.NoError(t, err)
	require.NotNil(t, first)
	require.NotEmpty(t, first.InputDigest)
	require.NotEqual(t, `{"repo":"owner/name"}`, first.InputDigest)

	second, err := AppendAgentRunEvent(AgentRunEventInput{
		UserId:       7,
		DeviceId:     11,
		RequestId:    "request-1",
		EventType:    AgentRunEventTypeToolSucceeded,
		Operation:    "github.issues.list",
		OutputDigest: AgentRunEventDigest([]byte(`{"data":[]}`)),
		CreatedAt:     time.Unix(11, 0).UTC(),
	})
	require.NoError(t, err)
	require.Greater(t, second.ID, first.ID)

	events, err := ListAgentRunEvents(7, 11, first.ID, 10)
	require.NoError(t, err)
	require.Len(t, events, 1)
	require.Equal(t, second.ID, events[0].ID)

	otherUser, err := ListAgentRunEvents(8, 0, 0, 10)
	require.NoError(t, err)
	require.Empty(t, otherUser)
}

func TestAgentRunEventJournalRejectsUnknownOrUnscopedInput(t *testing.T) {
	setupAgentRunEventModelTest(t)
	_, err := AppendAgentRunEvent(AgentRunEventInput{
		UserId:     0,
		DeviceId:   11,
		RequestId:  "request-1",
		EventType:  AgentRunEventTypeToolRequested,
		Operation:  "github.auth.status",
	})
	require.ErrorIs(t, err, ErrAgentRunEventInvalid)
	_, err = AppendAgentRunEvent(AgentRunEventInput{
		UserId:     7,
		DeviceId:   11,
		RequestId:  "request-1",
		EventType:  "unknown",
		Operation:  "github.auth.status",
	})
	require.ErrorIs(t, err, ErrAgentRunEventInvalid)
	_, err = ListAgentRunEvents(7, -1, 0, 10)
	require.ErrorIs(t, err, ErrAgentRunEventInvalid)
}
