package router

import (
	"embed"
	"mime"
	"net/http"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/controller"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/gin-contrib/gzip"
	"github.com/gin-contrib/static"
	"github.com/gin-gonic/gin"
)

// WebAssets holds the embedded dashboard frontend assets.
type WebAssets struct {
	BuildFS   embed.FS
	IndexPage []byte
}

func SetWebRouter(router *gin.Engine, assets WebAssets, pluginDispatcher gin.HandlerFunc) {
	// Some Linux images do not ship a MIME database entry for .webmanifest.
	// Register it explicitly so browsers can discover and install the PWA.
	_ = mime.AddExtensionType(".webmanifest", "application/manifest+json")
	frontendFS := common.EmbedFolder(assets.BuildFS, "web/dist")

	router.NoRoute(
		pluginDispatcher,
		middleware.RouteTag("web"),
		gzip.Gzip(gzip.DefaultCompression),
		middleware.GlobalWebRateLimit(),
		middleware.Cache(),
		static.Serve("/", frontendFS),
		func(c *gin.Context) {
			path := c.Request.URL.Path
			// Never serve the SPA HTML fallback for a missing asset. A stale
			// document may request an old hashed chunk after a deployment; the
			// correct response is 404 so the frontend recovery handler can fetch
			// a fresh document instead of parsing HTML as JavaScript.
			if strings.HasPrefix(path, "/v1") ||
				strings.HasPrefix(path, "/api") ||
				strings.HasPrefix(path, "/assets") ||
				strings.HasPrefix(path, "/static/") ||
				strings.Contains(path, ".") {
				controller.RelayNotFound(c)
				return
			}
			c.Header("Cache-Control", "no-cache")
			c.Data(http.StatusOK, "text/html; charset=utf-8", assets.IndexPage)
		},
	)
}
