package common

import (
	"embed"
	"io/fs"
	"net/http"
	"os"

	"github.com/gin-contrib/static"
)

// Credit: https://github.com/gin-contrib/static/issues/19

type embedFileSystem struct {
	http.FileSystem
}

func (e *embedFileSystem) Exists(prefix string, path string) bool {
	file, err := e.Open(path)
	if err != nil {
		return false
	}
	info, err := file.Stat()
	_ = file.Close()
	if err != nil {
		return false
	}
	if !info.IsDir() {
		return true
	}

	indexPath := path
	if len(indexPath) == 0 || indexPath[len(indexPath)-1] != '/' {
		indexPath += "/"
	}
	index, err := e.Open(indexPath + static.INDEX)
	if err != nil {
		return false
	}
	indexInfo, err := index.Stat()
	_ = index.Close()
	return err == nil && !indexInfo.IsDir()
}

func (e *embedFileSystem) Open(name string) (http.File, error) {
	if name == "/" {
		// This will make sure the index page goes to NoRouter handler,
		// which will use the replaced index bytes with analytic codes.
		return nil, os.ErrNotExist
	}
	return e.FileSystem.Open(name)
}

func EmbedFolder(fsEmbed embed.FS, targetPath string) static.ServeFileSystem {
	efs, err := fs.Sub(fsEmbed, targetPath)
	if err != nil {
		panic(err)
	}
	return &embedFileSystem{
		FileSystem: http.FS(efs),
	}
}
