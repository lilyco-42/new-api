package controller

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func setupAgentWebSessionControllerTest(t *testing.T) {
	t.Helper()
	previousDB := model.DB
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	sqlDB, err := db.DB()
	require.NoError(t, err)
	sqlDB.SetMaxOpenConns(1)
	model.DB = db
	require.NoError(t, model.DB.AutoMigrate(&model.AgentWebSession{}))
	t.Cleanup(func() {
		model.DB = previousDB
		_ = sqlDB.Close()
	})
}

func TestCreateAgentWebSessionUsesAuthenticatedIdentityAndRejectsClientFields(t *testing.T) {
	setupAgentWebSessionControllerTest(t)
	previousGinMode := gin.Mode()
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() { gin.SetMode(previousGinMode) })

	recorder := httptest.NewRecorder()
	context, _ := gin.CreateTestContext(recorder)
	context.Request = httptest.NewRequest("POST", "/api/agent/sessions", nil)
	context.Set("id", 7)
	CreateAgentWebSession(context)
	require.Equal(t, 200, recorder.Code)

	var envelope struct {
		Data struct {
			SessionID string `json:"session_id"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &envelope))
	require.Len(t, envelope.Data.SessionID, 64)
	var persisted model.AgentWebSession
	require.NoError(t, model.DB.Where("public_session_id = ?", envelope.Data.SessionID).First(&persisted).Error)
	require.Equal(t, 7, persisted.UserId)
	require.NotContains(t, recorder.Body.String(), persisted.DshSessionId)
	require.NotContains(t, recorder.Body.String(), "user_id")

	forgedRecorder := httptest.NewRecorder()
	forgedContext, _ := gin.CreateTestContext(forgedRecorder)
	forgedContext.Request = httptest.NewRequest("POST", "/api/agent/sessions", strings.NewReader(`{"user_id":8,"dsh_session_id":"chosen","cwd":"/"}`))
	forgedContext.Set("id", 7)
	CreateAgentWebSession(forgedContext)
	require.Equal(t, 400, forgedRecorder.Code)
	var count int64
	require.NoError(t, model.DB.Model(&model.AgentWebSession{}).Count(&count).Error)
	require.EqualValues(t, 1, count)
}

func TestRevokeAgentWebSessionIsScopedToAuthenticatedIdentity(t *testing.T) {
	setupAgentWebSessionControllerTest(t)
	previousGinMode := gin.Mode()
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() { gin.SetMode(previousGinMode) })
	owned, err := model.CreateAgentWebSession(7)
	require.NoError(t, err)

	recorder := httptest.NewRecorder()
	context, _ := gin.CreateTestContext(recorder)
	context.Request = httptest.NewRequest("DELETE", "/api/agent/sessions/"+owned.PublicSessionId, nil)
	context.Params = gin.Params{{Key: "id", Value: owned.PublicSessionId}}
	context.Set("id", 8)
	RevokeAgentWebSession(context)
	require.Equal(t, 404, recorder.Code)
	_, err = model.ResolveAgentWebSession(7, owned.PublicSessionId)
	require.NoError(t, err)
}
