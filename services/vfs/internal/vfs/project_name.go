package vfs

import (
	"os"
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

// ResolveGitRemote returns a display remote for clients (e.g. github.com/org/repo).
// Empty when origin is missing — clients should not fall back to container paths
// like /app/main_repo for UI subtitles.
func ResolveGitRemote(root string) string {
	raw := gitOriginURL(root)
	if raw == "" {
		return ""
	}
	return formatRemoteForDisplay(raw)
}

// ResolveGitBranch returns the current branch name of the workspace repo.
// Empty when not a git repo, git missing, or detached HEAD (HEAD is a commit).
func ResolveGitBranch(root string) string {
	// Prefer symbolic-ref so detached HEAD yields empty (not a short sha).
	out, err := gitOutput(root, "symbolic-ref", "--short", "HEAD")
	if err == nil {
		if b := strings.TrimSpace(string(out)); b != "" {
			return b
		}
	}
	// Fallback: rev-parse --abbrev-ref HEAD (returns "HEAD" when detached).
	out, err = gitOutput(root, "rev-parse", "--abbrev-ref", "HEAD")
	if err != nil {
		return ""
	}
	b := strings.TrimSpace(string(out))
	if b == "" || b == "HEAD" {
		return ""
	}
	return b
}

func gitOriginURL(root string) string {
	out, err := gitOutput(root, "remote", "get-url", "origin")
	if err != nil {
		// No origin, not a git repo, or git missing — fall through.
		return ""
	}
	return strings.TrimSpace(string(out))
}

func gitOriginRepoName(root string) string {
	return repoNameFromRemoteURL(gitOriginURL(root))
}

// formatRemoteForDisplay normalizes origin URLs to host/org/repo (no scheme, no .git).
func formatRemoteForDisplay(raw string) string {
	if raw == "" {
		return ""
	}
	u := strings.TrimSpace(raw)
	u = strings.TrimSuffix(u, "/")
	u = strings.TrimSuffix(u, ".git")

	// https://host/org/repo or ssh://git@host/org/repo
	if i := strings.Index(u, "://"); i >= 0 {
		u = u[i+3:]
		// drop userinfo git@
		if at := strings.Index(u, "@"); at >= 0 {
			u = u[at+1:]
		}
		return u
	}

	// scp-like: git@host:org/repo
	if strings.Contains(u, ":") && !strings.Contains(u, "://") {
		// strip optional user@
		hostPath := u
		if at := strings.LastIndex(u, "@"); at >= 0 {
			hostPath = u[at+1:]
		}
		if i := strings.Index(hostPath, ":"); i >= 0 && i+1 < len(hostPath) {
			return hostPath[:i] + "/" + hostPath[i+1:]
		}
		return hostPath
	}

	return u
}

// repoNameFromRemoteURL extracts the repository name from common git remote forms.
func repoNameFromRemoteURL(raw string) string {
	if raw == "" {
		return ""
	}
	// Reuse display form so path segment is stable across URL styles.
	display := formatRemoteForDisplay(raw)
	if display == "" {
		display = strings.TrimSpace(raw)
		display = strings.TrimSuffix(display, "/")
		display = strings.TrimSuffix(display, ".git")
	}
	if i := strings.LastIndex(display, "/"); i >= 0 && i+1 < len(display) {
		return display[i+1:]
	}
	if display != "" {
		return display
	}
	return ""
}
