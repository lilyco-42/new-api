package controller

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/oauth"
	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

type agentBindOAuthProvider struct {
	accessToken string
}

func (*agentBindOAuthProvider) GetName() string { return "GitHub" }
func (*agentBindOAuthProvider) IsEnabled() bool { return true }
func (provider *agentBindOAuthProvider) ExchangeToken(context.Context, string, *gin.Context) (*oauth.OAuthToken, error) {
	return &oauth.OAuthToken{AccessToken: provider.accessToken, Scope: "repo read:user"}, nil
}
func (*agentBindOAuthProvider) GetUserInfo(context.Context, *oauth.OAuthToken) (*oauth.OAuthUser, error) {
	return &oauth.OAuthUser{ProviderUserID: "github-agent-subject", Username: "agent-bind-owner"}, nil
}
func (*agentBindOAuthProvider) IsUserIDTaken(string) bool { return false }
func (*agentBindOAuthProvider) FillUserByProviderID(*model.User, string) error {
	return gorm.ErrRecordNotFound
}
func (*agentBindOAuthProvider) SetProviderUserID(user *model.User, subject string) {
	user.GitHubId = subject
}
func (*agentBindOAuthProvider) GetProviderPrefix() string    { return "github_" }
func (*agentBindOAuthProvider) ProviderUserIDColumn() string { return "github_id" }

func TestOAuthGitHubAgentBindReportsPersistenceOutcome(t *testing.T) {
	tests := []struct {
		name        string
		dropTable   any
		wantSuccess bool
	}{
		{name: "stores account binding and encrypted Agent grant", wantSuccess: true},
		{name: "binding database write fails", dropTable: &model.User{}},
		{name: "Agent grant database write fails", dropTable: &model.AgentGitHubCredential{}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			previousDB := model.DB
			previousDatabaseType := common.MainDatabaseType()
			previousCryptoSecret := common.CryptoSecret
			previousSessionSecret := common.SessionSecret
			previousGinMode := gin.Mode()
			db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
			require.NoError(t, err)
			sqlDB, err := db.DB()
			require.NoError(t, err)
			sqlDB.SetMaxOpenConns(1)
			model.DB = db
			common.SetMainDatabaseType(common.DatabaseTypeSQLite)
			common.CryptoSecret = "agent-bind-test-encryption-secret"
			common.SessionSecret = "agent-bind-test-session-secret"
			gin.SetMode(gin.TestMode)
			t.Cleanup(func() {
				model.DB = previousDB
				common.SetMainDatabaseType(previousDatabaseType)
				common.CryptoSecret = previousCryptoSecret
				common.SessionSecret = previousSessionSecret
				gin.SetMode(previousGinMode)
				_ = sqlDB.Close()
			})
			require.NoError(t, db.AutoMigrate(&model.User{}, &model.AuthFlow{}, &model.AgentGitHubCredential{}))
			owner := &model.User{
				Username: "agent-bind-owner", Password: "password-placeholder",
				Role: common.RoleCommonUser, Status: common.UserStatusEnabled,
				Group: "default", AffCode: "agent-bind-owner-aff", AuthVersion: 1,
			}
			require.NoError(t, db.Create(owner).Error)
			flowToken, flow, err := model.CreateAuthFlow(model.AuthFlowCreate{
				Purpose: model.AuthFlowPurposeOAuth, Provider: "github", Intent: model.AuthFlowIntentBind,
				UserId: owner.Id, SessionId: "agent-bind-session", Payload: "{}", ExpiresAt: time.Now().Add(time.Minute),
			})
			require.NoError(t, err)
			if test.dropTable != nil {
				// Exercise an actual SQLite storage error after the one-time flow
				// exists; neither persistence operation is replaced by a stub.
				require.NoError(t, db.Migrator().DropTable(test.dropTable))
			}
			provider := &agentBindOAuthProvider{accessToken: "synthetic-agent-bind-oauth-token"}
			recorder := httptest.NewRecorder()
			c, _ := gin.CreateTestContext(recorder)
			c.Request = httptest.NewRequest(http.MethodGet, "/api/oauth/github?code=synthetic-code", nil)

			handleOAuthBind(c, provider, flow, flowToken)

			require.Equal(t, http.StatusOK, recorder.Code)
			var response struct {
				Success bool `json:"success"`
				Data    struct {
					Action string `json:"action"`
				} `json:"data"`
			}
			require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &response))
			assert.Equal(t, test.wantSuccess, response.Success, "authorization success must reflect durable persistence")
			assert.NotContains(t, recorder.Body.String(), provider.accessToken)
			assert.NotContains(t, recorder.Body.String(), flowToken)
			_, err = model.GetAuthFlow(flowToken, model.AuthFlowMatch{
				Purpose: model.AuthFlowPurposeOAuth, Provider: "github", Intent: model.AuthFlowIntentBind,
				UserId: owner.Id, SessionId: "agent-bind-session",
			})
			assert.ErrorIs(t, err, model.ErrAuthFlowConsumed, "storage failure must not make the exchanged OAuth flow replayable")
			if !test.wantSuccess {
				assert.Empty(t, response.Data.Action, "failed authorization must not report bind completion")
				_, unavailableToken, credentialErr := model.GetAgentGitHubCredential(owner.Id)
				assert.Error(t, credentialErr)
				assert.Empty(t, unavailableToken, "failed persistence must not yield a usable Agent grant")
				return
			}
			assert.Equal(t, "bind", response.Data.Action)
			var persistedOwner model.User
			require.NoError(t, db.First(&persistedOwner, owner.Id).Error)
			assert.Equal(t, "github-agent-subject", persistedOwner.GitHubId)
			credential, decryptedToken, err := model.GetAgentGitHubCredential(owner.Id)
			require.NoError(t, err)
			assert.Equal(t, owner.Id, credential.UserId)
			assert.Equal(t, "github-agent-subject", credential.ProviderUserId)
			assert.Equal(t, "agent-bind-owner", credential.Login)
			assert.Equal(t, "repo read:user", credential.Scope)
			assert.Equal(t, provider.accessToken, decryptedToken)
			assert.NotContains(t, credential.EncryptedToken, provider.accessToken)
			_, foreignToken, err := model.GetAgentGitHubCredential(owner.Id + 1)
			assert.ErrorIs(t, err, gorm.ErrRecordNotFound)
			assert.Empty(t, foreignToken)
		})
	}
}
