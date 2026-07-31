package vfs

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// resolveSafe joins root and a client path, rejecting escapes outside root.
func resolveSafe(root, clientPath string) (abs string, rel string, err error) {
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return "", "", err
	}
	rootAbs = filepath.Clean(rootAbs)

	raw := strings.TrimSpace(clientPath)
	if raw == "" || raw == "." {
		return rootAbs, ".", nil
	}
	// Normalize separators; reject absolute and null-byte paths.
	if filepath.IsAbs(raw) {
		return "", "", fmt.Errorf("absolute paths are not allowed: %s", raw)
	}
	if strings.Contains(raw, "\x00") {
		return "", "", fmt.Errorf("invalid path")
	}

	rel = filepath.ToSlash(filepath.Clean(raw))
	if rel == ".." || strings.HasPrefix(rel, "../") {
		return "", "", fmt.Errorf("path escapes workspace root: %s", clientPath)
	}

	abs = filepath.Join(rootAbs, filepath.FromSlash(rel))
	abs = filepath.Clean(abs)

	// Ensure abs is under rootAbs (prefix + separator or exact match).
	if abs != rootAbs && !strings.HasPrefix(abs, rootAbs+string(os.PathSeparator)) {
		return "", "", fmt.Errorf("path escapes workspace root: %s", clientPath)
	}
	return abs, rel, nil
}
