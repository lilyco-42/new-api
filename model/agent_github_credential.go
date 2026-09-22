package model

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"gorm.io/gorm"
)

// AgentGitHubCredential stores the GitHub token granted specifically to the
// browser Agent. The token is encrypted at rest and never exposed through a
// JSON response. It is separate from the login binding so revoking Agent
// access does not sign the user out of Lain42.
type AgentGitHubCredential struct {
	Id             int       `json:"id" gorm:"primaryKey"`
	UserId         int       `json:"user_id" gorm:"not null;uniqueIndex"`
	ProviderUserId string    `json:"provider_user_id" gorm:"type:varchar(128);not null;index"`
	Login          string    `json:"login" gorm:"type:varchar(128);not null"`
	Scope          string    `json:"scope,omitempty" gorm:"type:varchar(512)"`
	EncryptedToken string    `json:"-" gorm:"type:text;not null"`
	CreatedAt      time.Time `json:"created_at"`
	UpdatedAt      time.Time `json:"updated_at"`
}

func (AgentGitHubCredential) TableName() string { return "agent_github_credentials" }

var errAgentGitHubSecret = errors.New("agent GitHub credential is unavailable")

func agentGitHubCipher() (cipher.AEAD, error) {
	secret := strings.TrimSpace(common.CryptoSecret)
	if secret == "" {
		return nil, errAgentGitHubSecret
	}
	key := sha256.Sum256([]byte("lain42-agent-github-v1:" + secret))
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

func encryptAgentGitHubToken(token string) (string, error) {
	token = strings.TrimSpace(token)
	if token == "" {
		return "", errAgentGitHubSecret
	}
	aead, err := agentGitHubCipher()
	if err != nil {
		return "", err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", err
	}
	sealed := aead.Seal(nonce, nonce, []byte(token), nil)
	return base64.RawURLEncoding.EncodeToString(sealed), nil
}

func decryptAgentGitHubToken(value string) (string, error) {
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimSpace(value))
	if err != nil {
		return "", errAgentGitHubSecret
	}
	aead, err := agentGitHubCipher()
	if err != nil {
		return "", err
	}
	if len(raw) < aead.NonceSize() {
		return "", errAgentGitHubSecret
	}
	nonce, ciphertext := raw[:aead.NonceSize()], raw[aead.NonceSize():]
	plaintext, err := aead.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return "", errAgentGitHubSecret
	}
	return string(plaintext), nil
}

// SaveAgentGitHubCredential upserts a user's current GitHub Agent grant.
func SaveAgentGitHubCredential(userID int, providerUserID, login, scope, token string) error {
	if userID <= 0 || strings.TrimSpace(providerUserID) == "" || strings.TrimSpace(login) == "" {
		return fmt.Errorf("invalid GitHub credential identity")
	}
	encrypted, err := encryptAgentGitHubToken(token)
	if err != nil {
		return err
	}
	values := map[string]any{
		"provider_user_id": strings.TrimSpace(providerUserID),
		"login":            strings.TrimSpace(login),
		"scope":            strings.TrimSpace(scope),
		"encrypted_token":  encrypted,
		"updated_at":       time.Now(),
	}
	var existing AgentGitHubCredential
	err = DB.Where("user_id = ?", userID).First(&existing).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return DB.Create(&AgentGitHubCredential{
			UserId:         userID,
			ProviderUserId: values["provider_user_id"].(string),
			Login:          values["login"].(string),
			Scope:          values["scope"].(string),
			EncryptedToken: encrypted,
		}).Error
	}
	if err != nil {
		return err
	}
	return DB.Model(&existing).Updates(values).Error
}

// GetAgentGitHubCredential returns metadata and the decrypted token for an
// authenticated server-side GitHub request. Callers must not serialize it.
func GetAgentGitHubCredential(userID int) (*AgentGitHubCredential, string, error) {
	if userID <= 0 {
		return nil, "", gorm.ErrRecordNotFound
	}
	var credential AgentGitHubCredential
	if err := DB.Where("user_id = ?", userID).First(&credential).Error; err != nil {
		return nil, "", err
	}
	token, err := decryptAgentGitHubToken(credential.EncryptedToken)
	if err != nil {
		return nil, "", err
	}
	return &credential, token, nil
}

func DeleteAgentGitHubCredential(userID int) error {
	if userID <= 0 {
		return gorm.ErrRecordNotFound
	}
	return DB.Where("user_id = ?", userID).Delete(&AgentGitHubCredential{}).Error
}
