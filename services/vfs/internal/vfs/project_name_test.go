package vfs

import "testing"

func TestFormatRemoteForDisplay(t *testing.T) {
	cases := map[string]string{
		"https://github.com/org/repo.git":     "github.com/org/repo",
		"https://github.com/org/repo":         "github.com/org/repo",
		"git@github.com:org/repo.git":         "github.com/org/repo",
		"ssh://git@github.com/org/repo.git":   "github.com/org/repo",
		"https://gitlab.com/g/sub/repo.git":   "gitlab.com/g/sub/repo",
	}
	for in, want := range cases {
		if got := formatRemoteForDisplay(in); got != want {
			t.Fatalf("formatRemoteForDisplay(%q)=%q want %q", in, got, want)
		}
	}
}

func TestRepoNameFromRemoteURL(t *testing.T) {
	if got := repoNameFromRemoteURL("git@github.com:org/HelmCode.git"); got != "HelmCode" {
		t.Fatalf("got %q", got)
	}
}

func TestResolveGitBranch(t *testing.T) {
	// Non-repo path → empty (no panic, no invented "main").
	if got := ResolveGitBranch(t.TempDir()); got != "" {
		t.Fatalf("non-repo branch=%q want empty", got)
	}
}
