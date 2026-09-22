package model

import (
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/stretchr/testify/require"
)

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
