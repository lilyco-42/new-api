package router

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/i18n"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestAgentDSHProductionModelRouteUsesOwnerWallet(t *testing.T) {
	require.NoError(t, i18n.Init())
	const path = "/v1/agent/chat/completions"
	const modelName = "gpt-3.5-turbo"
	const secret = "synthetic-model-relay-secret-32-bytes"
	tests := []struct {
		name          string
		quota         int
		body          string
		badSignature  bool
		wantStatus    int
		wantUpstreams int32
	}{
		{name: "account-owned answer without API token", quota: 100000, wantStatus: http.StatusOK, wantUpstreams: 1},
		{name: "empty wallet", wantStatus: http.StatusForbidden},
		{name: "invalid signature", quota: 100000, badSignature: true, wantStatus: http.StatusUnauthorized},
		{name: "missing chat messages", quota: 100000, body: `{"model":"gpt-3.5-turbo"}`, wantStatus: http.StatusBadRequest},
	}
	for index, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			previousDB, previousLogDB := model.DB, model.LOG_DB
			previousMainType, previousLogType := common.MainDatabaseType(), common.LogDatabaseType()
			previousRedis, previousMemory, previousBatch := common.RedisEnabled, common.MemoryCacheEnabled, common.BatchUpdateEnabled
			previousLogs, previousExport := common.LogConsumeEnabled, common.DataExportEnabled
			previousRateLimit, previousCountToken := setting.ModelRequestRateLimitEnabled, constant.CountToken
			previousPerformance, previousMode := common.GetPerformanceMonitorConfig(), gin.Mode()
			previousMaster, previousSQLitePath := common.IsMasterNode, common.SQLitePath
			common.IsMasterNode = false
			common.SQLitePath = fmt.Sprintf("file:agent_model_%d?mode=memory&cache=shared", index)
			t.Setenv("SQL_DSN", "local")
			t.Setenv("LOG_SQL_DSN", "")
			// InitDB also initializes dialect-specific column names used by real
			// channel selection and billing; direct gorm.Open would miss them.
			require.NoError(t, model.InitDB())
			db := model.DB
			sqlDB, err := db.DB()
			require.NoError(t, err)
			sqlDB.SetMaxOpenConns(1)
			model.DB, model.LOG_DB = db, db
			common.SetDatabaseTypes(common.DatabaseTypeSQLite, common.DatabaseTypeSQLite)
			common.RedisEnabled, common.MemoryCacheEnabled, common.BatchUpdateEnabled = false, false, false
			common.LogConsumeEnabled, common.DataExportEnabled = true, false
			setting.ModelRequestRateLimitEnabled, constant.CountToken = false, false
			// No machine performance sampler runs in this deterministic fixture.
			common.SetPerformanceMonitorConfig(common.PerformanceMonitorConfig{})
			gin.SetMode(gin.TestMode)
			t.Setenv("LAIN42_AGENT_MODEL_RELAY_SECRET", secret)
			t.Cleanup(func() {
				model.DB, model.LOG_DB = previousDB, previousLogDB
				common.SetDatabaseTypes(previousMainType, previousLogType)
				common.RedisEnabled, common.MemoryCacheEnabled, common.BatchUpdateEnabled = previousRedis, previousMemory, previousBatch
				common.LogConsumeEnabled, common.DataExportEnabled = previousLogs, previousExport
				setting.ModelRequestRateLimitEnabled, constant.CountToken = previousRateLimit, previousCountToken
				common.SetPerformanceMonitorConfig(previousPerformance)
				common.IsMasterNode, common.SQLitePath = previousMaster, previousSQLitePath
				gin.SetMode(previousMode)
				_ = sqlDB.Close()
			})
			require.NoError(t, db.AutoMigrate(&model.User{}, &model.Token{}, &model.Channel{}, &model.Ability{}, &model.AgentDSHSession{}, &model.AuthFlow{}, &model.Log{}))
			owner := model.User{
				Username: "hosted-model-owner", Status: common.UserStatusEnabled, Role: common.RoleCommonUser,
				Group: "default", AuthVersion: 1, Quota: test.quota, AffCode: "hosted-model-owner-aff",
				Setting: `{"billing_preference":"wallet_only"}`,
			}
			other := model.User{
				Username: "hosted-model-other", Status: common.UserStatusEnabled, Role: common.RoleCommonUser,
				Group: "default", AuthVersion: 1, Quota: 12345, AffCode: "hosted-model-other-aff",
			}
			require.NoError(t, db.Create(&owner).Error)
			require.NoError(t, db.Create(&other).Error)
			session, err := model.CreateAgentDSHSession(owner.Id, time.Now().UTC())
			require.NoError(t, err)
			type upstreamObservation struct {
				path, authorization string
				body                string
			}
			observations := make(chan upstreamObservation, 4)
			var upstreamCalls atomic.Int32
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				upstreamCalls.Add(1)
				body, readErr := io.ReadAll(r.Body)
				if readErr != nil {
					http.Error(w, "fixture request read failed", http.StatusBadRequest)
					return
				}
				observations <- upstreamObservation{path: r.URL.Path, authorization: r.Header.Get("Authorization"), body: string(body)}
				w.Header().Set("Content-Type", "application/json")
				_, _ = io.WriteString(w, `{"id":"chatcmpl-owner-wallet","object":"chat.completion","created":1,"model":"gpt-3.5-turbo","choices":[{"index":0,"message":{"role":"assistant","content":"The Issue needs a persistence error check."},"finish_reason":"stop"}],"usage":{"prompt_tokens":20,"completion_tokens":10,"total_tokens":30}}`)
			}))
			t.Cleanup(upstream.Close)
			baseURL := upstream.URL
			channel := model.Channel{
				Type: constant.ChannelTypeOpenAI, Key: "synthetic-upstream-only-key", Status: common.ChannelStatusEnabled,
				Name: "hosted-model-fixture", Group: "default", Models: modelName, BaseURL: &baseURL,
			}
			require.NoError(t, channel.Insert())
			engine := gin.New()
			SetRelayRouter(engine)
			body := test.body
			if body == "" {
				body = `{"model":"gpt-3.5-turbo","messages":[{"role":"user","content":"Explain the Issue."}],"max_tokens":32,"stream":false}`
			}
			timestamp := fmt.Sprintf("%d", time.Now().UTC().Unix())
			nonce := fmt.Sprintf("%032x", index+1)
			canonical := fmt.Sprintf("v1\n%s\n%s\nPOST\n%s\n%s\n%s", timestamp, nonce, path, session.SessionId, modelName)
			signature := common.GenerateHMACWithKey([]byte(secret), canonical)
			if test.badSignature {
				signature = strings.Repeat("0", 64)
			}
			request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("X-Lain42-Agent-Session", session.SessionId)
			request.Header.Set("X-Lain42-Agent-Model", modelName)
			request.Header.Set("X-Lain42-Timestamp", timestamp)
			request.Header.Set("X-Lain42-Nonce", nonce)
			request.Header.Set("X-Lain42-Signature", signature)
			response := httptest.NewRecorder()
			engine.ServeHTTP(response, request)

			require.Equal(t, test.wantStatus, response.Code, response.Body.String())
			assert.Equal(t, test.wantUpstreams, upstreamCalls.Load())
			var updatedOwner, updatedOther model.User
			require.NoError(t, db.First(&updatedOwner, owner.Id).Error)
			require.NoError(t, db.First(&updatedOther, other.Id).Error)
			assert.Equal(t, other.Quota, updatedOther.Quota)
			assert.Zero(t, updatedOther.UsedQuota)
			var tokenCount int64
			require.NoError(t, db.Model(&model.Token{}).Count(&tokenCount).Error)
			assert.Zero(t, tokenCount, "website inference must not require or mint an API token")
			var logs []model.Log
			require.NoError(t, db.Where("type = ?", model.LogTypeConsume).Find(&logs).Error)
			if test.wantUpstreams == 0 {
				assert.Equal(t, owner.Quota, updatedOwner.Quota)
				assert.Empty(t, logs)
				return
			}
			require.Len(t, observations, 1)
			observation := <-observations
			assert.Equal(t, "/v1/chat/completions", observation.path)
			assert.Equal(t, "Bearer synthetic-upstream-only-key", observation.authorization)
			assert.Contains(t, observation.body, "Explain the Issue.")
			assert.Contains(t, response.Body.String(), "The Issue needs a persistence error check.")
			require.Len(t, logs, 1, "a completed answer must have an account-owned usage entry")
			assert.Equal(t, owner.Id, logs[0].UserId)
			assert.Equal(t, channel.Id, logs[0].ChannelId)
			assert.Zero(t, logs[0].TokenId)
			assert.Greater(t, logs[0].Quota, 0)
			assert.Equal(t, owner.Quota-logs[0].Quota, updatedOwner.Quota)
			assert.Equal(t, logs[0].Quota, updatedOwner.UsedQuota)
		})
	}
}
