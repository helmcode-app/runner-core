package vfs

import (
	"fmt"
	"os/exec"
	"strings"
)

// isGitRepo reports whether root is inside a git work tree.
func isGitRepo(root string) bool {
	out, err := gitOutput(root, "rev-parse", "--is-inside-work-tree")
	if err != nil {
		return false
	}
	return strings.TrimSpace(string(out)) == "true"
}

func gitOutput(root string, args ...string) ([]byte, error) {
	cmd := exec.Command("git", append([]string{"-C", root}, args...)...)
	return cmd.Output()
}

func gitCombined(root string, args ...string) ([]byte, error) {
	cmd := exec.Command("git", append([]string{"-C", root}, args...)...)
	return cmd.CombinedOutput()
}

func validateGitRelPath(relPath string) error {
	if relPath == "" || strings.Contains(relPath, "\x00") {
		return fmt.Errorf("invalid path")
	}
	if strings.Contains(relPath, "..") {
		return fmt.Errorf("invalid path")
	}
	return nil
}

func validateGitRefName(ref string) error {
	if ref == "" {
		return fmt.Errorf("ref is required")
	}
	if strings.ContainsAny(ref, "\x00\n\r") {
		return fmt.Errorf("invalid ref")
	}
	if strings.HasPrefix(ref, "-") {
		return fmt.Errorf("invalid ref")
	}
	if strings.Contains(ref, "..") {
		return fmt.Errorf("invalid ref")
	}
	return nil
}

func truncateUTF8(s string, max int) (string, bool) {
	if len(s) <= max {
		return s, false
	}
	return s[:max], true
}
