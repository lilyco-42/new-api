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
	previousSecret := common.CryptoSecret
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	sqlDB, err := db.DB()
	require.NoError(t, err)
	sqlDB.SetMaxOpenConns(1)
	DB = db
	common.CryptoSecret = "agent-github-credential-test-secret"
	require.NoError(t, DB.AutoMigrate(&AgentGitHubCredential{}))
	t.Cleanup(func() {
		DB = previousDB
		common.CryptoSecret = previousSecret
		_ = sqlDB.Close()
	})
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

func TestAgentGitHubCredentialsAreIsolatedByAccount(t *testing.T) {
	setupAgentGitHubCredentialModelTest(t)
	require.NoError(t, SaveAgentGitHubCredential(
		7, "github-user-7", "user-seven", "repo", "token-for-seven",
	))
	require.NoError(t, SaveAgentGitHubCredential(
		8, "github-user-8", "user-eight", "repo", "token-for-eight",
	))

	userSeven, userSevenToken, err := GetAgentGitHubCredential(7)
	require.NoError(t, err)
	require.Equal(t, "user-seven", userSeven.Login)
	require.Equal(t, "token-for-seven", userSevenToken)

	userEight, userEightToken, err := GetAgentGitHubCredential(8)
	require.NoError(t, err)
	require.Equal(t, "user-eight", userEight.Login)
	require.Equal(t, "token-for-eight", userEightToken)

	require.NoError(t, DeleteAgentGitHubCredential(7))
	_, _, err = GetAgentGitHubCredential(7)
	require.ErrorIs(t, err, gorm.ErrRecordNotFound)
	remainingUser, remainingToken, err := GetAgentGitHubCredential(8)
	require.NoError(t, err)
	require.Equal(t, "user-eight", remainingUser.Login)
	require.Equal(t, "token-for-eight", remainingToken)

	// Credential records remain encrypted at rest even though the caller may
	// fetch its own decrypted token for an outbound GitHub request.
	var persisted AgentGitHubCredential
	require.NoError(t, DB.Where("user_id = ?", 8).First(&persisted).Error)
	require.NotContains(t, persisted.EncryptedToken, "token-for-eight")
}
