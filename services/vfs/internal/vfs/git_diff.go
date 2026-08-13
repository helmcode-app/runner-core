package vfs

import (
	"bytes"
	"fmt"
	"os/exec"
	"strings"
)

// collectGitDiff returns unified diff text for a workspace-relative path.
func collectGitDiff(root, relPath string, staged bool) (GitDiffResult, error) {
	res := GitDiffResult{Path: relPath, Staged: staged}
	if !isGitRepo(root) {
		return res, nil
	}
	if err := validateGitRelPath(relPath); err != nil {
		return res, err
	}

	args := []string{"diff", "--no-color"}
	if staged {
		args = append(args, "--cached")
	}
	args = append(args, "--", relPath)
	out, err := gitOutput(root, args...)
	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			if len(out) == 0 {
				return res, fmt.Errorf("git diff: %s", bytes.TrimSpace(ee.Stderr))
			}
			// Keep stdout when present (rare non-zero without --exit-code).
		} else {
			return res, fmt.Errorf("git diff: %w", err)
		}
	}

	diff := string(out)
	if strings.TrimSpace(diff) == "" && !staged {
		diff = diffUntracked(root, relPath)
	}

	res.Diff, res.Truncated = truncateUTF8(diff, MaxGitDiffBytes)
	return res, nil
}

// collectGitShow returns file contents at revision (default HEAD).
func collectGitShow(root, relPath, revision string) (GitShowResult, error) {
	rev := strings.TrimSpace(revision)
	if rev == "" {
		rev = "HEAD"
	}
	res := GitShowResult{Path: relPath, Revision: rev, Exists: false}
	if !isGitRepo(root) {
		return res, nil
	}
	if err := validateGitRelPath(relPath); err != nil {
		return res, err
	}

	spec := rev + ":" + relPath
	out, err := gitOutput(root, "show", "--textconv", spec)
	if err != nil {
		// Missing path at revision → exists=false (not an RPC error).
		return res, nil
	}
	res.Exists = true
	if isLikelyBinary(out) {
		res.Binary = true
		return res, nil
	}
	res.Content, res.Truncated = truncateUTF8(string(out), MaxGitShowBytes)
	return res, nil
}

func isLikelyBinary(b []byte) bool {
	// NUL in the first 8 KiB → treat as binary (same heuristic as git).
	n := len(b)
	if n > 8192 {
		n = 8192
	}
	return bytes.IndexByte(b[:n], 0) >= 0
}

func diffUntracked(root, relPath string) string {
	// Confirm the path is untracked / not in the index.
	if err := exec.Command("git", "-C", root, "ls-files", "--error-unmatch", "--", relPath).Run(); err == nil {
		return "" // tracked; empty worktree diff is fine
	}
	out, err := gitOutput(root, "diff", "--no-color", "--no-index", "--", "/dev/null", relPath)
	if err != nil {
		if _, ok := err.(*exec.ExitError); ok && len(out) > 0 {
			// --no-index exits 1 when files differ (always for new files).
			return string(out)
		}
		return ""
	}
	return string(out)
}
