/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
package common

import (
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestEmbedFileSystemFallsThroughDirectoryWithoutIndex(t *testing.T) {
	root := t.TempDir()
	assetDirectory := filepath.Join(root, "agent")
	require.NoError(t, os.Mkdir(assetDirectory, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(assetDirectory, "crawler_core.wasm"), []byte("wasm"), 0o644))

	filesystem := &embedFileSystem{FileSystem: http.Dir(root)}

	require.False(t, filesystem.Exists("/", "/agent"))
	require.False(t, filesystem.Exists("/", "/agent/"))
	require.True(t, filesystem.Exists("/", "/agent/crawler_core.wasm"))
}

func TestEmbedFileSystemServesDirectoryWithIndex(t *testing.T) {
	root := t.TempDir()
	pageDirectory := filepath.Join(root, "docs")
	require.NoError(t, os.Mkdir(pageDirectory, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(pageDirectory, "index.html"), []byte("page"), 0o644))

	filesystem := &embedFileSystem{FileSystem: http.Dir(root)}

	require.True(t, filesystem.Exists("/", "/docs"))
	require.True(t, filesystem.Exists("/", "/docs/"))
}
