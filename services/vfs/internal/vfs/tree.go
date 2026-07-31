package vfs

import (
	"io/fs"
	"os"
	"path/filepath"
)

// ScanTree walks root with WalkDir, skipping ignored directories.
func ScanTree(root string) ([]TreeEntry, error) {
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(rootAbs)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, fs.ErrInvalid
	}

	entries := make([]TreeEntry, 0, 256)
	err = filepath.WalkDir(rootAbs, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			if d != nil && d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		name := d.Name()
		if path != rootAbs && isIgnoredName(name) {
			if d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if path == rootAbs {
			return nil
		}

		rel, err := filepath.Rel(rootAbs, path)
		if err != nil {
			return nil
		}
		rel = filepath.ToSlash(rel)

		if d.IsDir() {
			entries = append(entries, TreeEntry{Path: rel, Size: 0, Type: EntryDir})
			return nil
		}

		var size int64
		if fi, err := d.Info(); err == nil {
			size = fi.Size()
		}
		entries = append(entries, TreeEntry{Path: rel, Size: size, Type: EntryFile})
		return nil
	})
	if err != nil {
		return nil, err
	}
	return entries, nil
}
