package channel

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Only the external provider's URL and header setup are supplied by this fixture.
type cancellationProviderAdaptor struct {
	Adaptor
	url string
}

func (a cancellationProviderAdaptor) GetRequestURL(_ *relaycommon.RelayInfo) (string, error) {
	return a.url, nil
}

func (a cancellationProviderAdaptor) SetupRequestHeader(_ *gin.Context, _ *http.Header, _ *relaycommon.RelayInfo) error {
	return nil
}

func TestCancelledClientDoesNotStartAnUpstreamAPIOrFormRequest(t *testing.T) {
	service.InitHttpClient()
	for _, tc := range []struct {
		name string
		send func(Adaptor, *gin.Context, *relaycommon.RelayInfo, io.Reader) (*http.Response, error)
	}{
		{name: "JSON API", send: DoApiRequest},
		{name: "multipart form", send: DoFormRequest},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var requests atomic.Int32
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				requests.Add(1)
				w.WriteHeader(http.StatusOK)
			}))
			defer upstream.Close()
			ctx, _ := gin.CreateTestContext(httptest.NewRecorder())
			requestContext, cancel := context.WithCancel(context.Background())
			ctx.Request = httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader("body")).WithContext(requestContext)
			cancel()

			response, err := tc.send(cancellationProviderAdaptor{url: upstream.URL}, ctx,
				&relaycommon.RelayInfo{ChannelMeta: &relaycommon.ChannelMeta{}}, strings.NewReader("body"))
			if response != nil {
				_ = response.Body.Close()
			}
			require.ErrorIs(t, err, context.Canceled)
			assert.Zero(t, requests.Load(), "a cancelled request must not consume an upstream call")
		})
	}
}
