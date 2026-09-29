package model

import (
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func setupAgentGitHubCredentialModelTest(t *testing.T) {
	t.Helper()
	previousDB := DB
	previousCryptoSecret := common.CryptoSecret
	common.CryptoSecret = "agent-github-model-test-secret"
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	sqlDB, err := db.DB()
	require.NoError(t, err)
	sqlDB.SetMaxOpenConns(1)
	DB = db
	t.Cleanup(func() {
		DB = previousDB
		common.CryptoSecret = previousCryptoSecret
		_ = sqlDB.Close()
	})
	require.NoError(t, DB.AutoMigrate(&AgentGitHubCredential{}))
}

func TestAgentGitHubTokenEncryptionRoundTrip(t *testing.T) {
	previous := common.CryptoSecret
	common.CryptoSecret = "agent-github-test-secret"
	t.Cleanup(func() { common.CryptoSecret = previous })

	ciphertext, err := encryptAgentGitHubToken("gho_example_secret")
	require.NoError(t, err)
	require.NotContains(t, ciphertext, "gho_example_secret")

	plaintext, err := decryptAgentGitHubToken(ciphertext)
	require.NoError(t, err)
	require.Equal(t, "gho_example_secret", plaintext)
}

func TestAgentGitHubTokenCannotDecryptWithDifferentSecret(t *testing.T) {
	previous := common.CryptoSecret
	common.CryptoSecret = "agent-github-test-secret"
	t.Cleanup(func() { common.CryptoSecret = previous })

	ciphertext, err := encryptAgentGitHubToken("gho_example_secret")
	require.NoError(t, err)
	common.CryptoSecret = "different-secret"
	_, err = decryptAgentGitHubToken(ciphertext)
	require.Error(t, err)
}

func TestAgentGitHubCredentialReadsAndDeletesAreScopedToUser(t *testing.T) {
	setupAgentGitHubCredentialModelTest(t)
	require.NoError(t, SaveAgentGitHubCredential(
		7, "github-user-7", "user-seven", "read:user", "gho_user_seven",
	))
	require.NoError(t, SaveAgentGitHubCredential(
		8, "github-user-8", "user-eight", "read:user", "gho_user_eight",
	))

	userSeven, token, err := GetAgentGitHubCredential(7)
	require.NoError(t, err)
	require.Equal(t, 7, userSeven.UserId)
	require.Equal(t, "user-seven", userSeven.Login)
	require.Equal(t, "gho_user_seven", token)

	userEight, token, err := GetAgentGitHubCredential(8)
	require.NoError(t, err)
	require.Equal(t, 8, userEight.UserId)
	require.Equal(t, "user-eight", userEight.Login)
	require.Equal(t, "gho_user_eight", token)

	require.NoError(t, DeleteAgentGitHubCredential(7))
	_, _, err = GetAgentGitHubCredential(7)
	require.ErrorIs(t, err, gorm.ErrRecordNotFound)

	userEight, token, err = GetAgentGitHubCredential(8)
	require.NoError(t, err)
	require.Equal(t, 8, userEight.UserId)
	require.Equal(t, "gho_user_eight", token)
}
