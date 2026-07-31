package vfs

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// ResolveProjectName picks a human-facing workspace name for clients.
//
// Priority:
//  1. VFS_PROJECT_NAME or PROJECT_NAME env (explicit override)
//  2. git remote "origin" URL last path segment (repo name)
//  3. basename of root (e.g. main_repo in Docker — least preferred)
//
// Docker mounts often use a fixed path like /app/main_repo; relying on that
// basename makes every remote project look identical. Prefer git remote or env.
func ResolveProjectName(root string) string {
	for _, key := range []string{"VFS_PROJECT_NAME", "PROJECT_NAME"} {
		if v := strings.TrimSpace(os.Getenv(key)); v != "" {
			return v
		}
	}
	if name := gitOriginRepoName(root); name != "" {
		return name
	}
	base := filepath.Base(filepath.Clean(root))
	if base == "" || base == "." || base == string(filepath.Separator) {
		return "Workspace"
	}
	return base
}

func gitOriginRepoName(root string) string {
	cmd := exec.Command("git", "-C", root, "remote", "get-url", "origin")
	out, err := cmd.Output()
	if err != nil {
		// No origin, not a git repo, or git missing — fall through.
		return ""
	}
	return repoNameFromRemoteURL(strings.TrimSpace(string(out)))
}

// repoNameFromRemoteURL extracts the repository name from common git remote forms.
func repoNameFromRemoteURL(raw string) string {
	if raw == "" {
		return ""
	}
	u := strings.TrimSpace(raw)
	u = strings.TrimSuffix(u, "/")
	u = strings.TrimSuffix(u, ".git")

	// scp-like: git@host:org/repo
	if strings.Contains(u, ":") && !strings.Contains(u, "://") {
		if i := strings.LastIndex(u, ":"); i >= 0 && i+1 < len(u) {
			u = u[i+1:]
		}
	}

	// URL path or remaining org/repo
	if i := strings.LastIndex(u, "/"); i >= 0 && i+1 < len(u) {
		return u[i+1:]
	}
	if u != "" {
		return u
	}
	return ""
}
