package vfs

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseGitStatusPorcelainV2(t *testing.T) {
	raw := `# branch.oid abcdef
# branch.head feature/x
# branch.upstream origin/feature/x
# branch.ab +2 -1
1 .M S 100644 100644 100644 aaa bbb path/a.go
1 A. S 100644 100644 100644 aaa bbb new.txt
1 D. S 100644 000000 000000 aaa bbb gone.txt
2 R. S 100644 100644 100644 aaa bbb R100	renamed.txt	old.txt
? untracked.md
`
	got := parseGitStatusPorcelainV2([]byte(raw))
	if !got.IsRepo {
		t.Fatal("expected isRepo")
	}
	if got.Branch != "feature/x" {
		t.Fatalf("branch=%q", got.Branch)
	}
	if got.Upstream != "origin/feature/x" {
		t.Fatalf("upstream=%q", got.Upstream)
	}
	if got.Ahead == nil || *got.Ahead != 2 || got.Behind == nil || *got.Behind != 1 {
		t.Fatalf("ahead/behind=%v/%v", got.Ahead, got.Behind)
	}
	if len(got.Changes) != 5 {
		t.Fatalf("changes=%d %+v", len(got.Changes), got.Changes)
	}

	byPath := map[string]GitChangeEntry{}
	for _, c := range got.Changes {
		byPath[c.Path] = c
	}
	if c := byPath["path/a.go"]; c.Status != GitStatusModified || c.Staged {
		t.Fatalf("a.go=%+v", c)
	}
	if c := byPath["new.txt"]; c.Status != GitStatusAdded || !c.Staged {
		t.Fatalf("new.txt=%+v", c)
	}
	if c := byPath["gone.txt"]; c.Status != GitStatusDeleted || !c.Staged {
		t.Fatalf("gone.txt=%+v", c)
	}
	if c := byPath["renamed.txt"]; c.Status != GitStatusRenamed || c.FromPath != "old.txt" || !c.Staged {
		t.Fatalf("renamed=%+v", c)
	}
	if c := byPath["untracked.md"]; c.Status != GitStatusUntracked || c.Staged {
		t.Fatalf("untracked=%+v", c)
	}
}

func TestParseGitStatusDetached(t *testing.T) {
	raw := "# branch.head (detached)\n"
	got := parseGitStatusPorcelainV2([]byte(raw))
	if got.Branch != "" {
		t.Fatalf("detached branch=%q want empty", got.Branch)
	}
}

func TestCollectGitStatusNonRepo(t *testing.T) {
	got, err := collectGitStatus(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if got.IsRepo {
		t.Fatal("expected non-repo")
	}
	if got.Changes == nil {
		t.Fatal("changes should be empty slice")
	}
}

func requireGit(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}
}

func initTestRepo(t *testing.T) string {
	t.Helper()
	requireGit(t)
	root := t.TempDir()
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", root}, args...)...)
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=test",
			"GIT_AUTHOR_EMAIL=test@example.com",
			"GIT_COMMITTER_NAME=test",
			"GIT_COMMITTER_EMAIL=test@example.com",
		)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	run("init", "-b", "main")
	run("config", "user.email", "test@example.com")
	run("config", "user.name", "test")
	if err := os.WriteFile(filepath.Join(root, "tracked.txt"), []byte("one\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", "tracked.txt")
	run("commit", "-m", "init")
	run("tag", "v0.1.0")
	run("branch", "develop")
	return root
}

func TestCollectGitStatusAndDiffIntegration(t *testing.T) {
	root := initTestRepo(t)

	if err := os.WriteFile(filepath.Join(root, "tracked.txt"), []byte("two\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "fresh.txt"), []byte("new\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	st, err := collectGitStatus(root)
	if err != nil {
		t.Fatal(err)
	}
	if !st.IsRepo || st.Branch != "main" {
		t.Fatalf("status=%+v", st)
	}
	byPath := map[string]GitChangeEntry{}
	for _, c := range st.Changes {
		byPath[c.Path] = c
	}
	if c, ok := byPath["tracked.txt"]; !ok || c.Status != GitStatusModified {
		t.Fatalf("tracked change=%+v ok=%v all=%+v", c, ok, st.Changes)
	}
	if c, ok := byPath["fresh.txt"]; !ok || c.Status != GitStatusUntracked {
		t.Fatalf("fresh change=%+v ok=%v", c, ok)
	}

	diff, err := collectGitDiff(root, "tracked.txt", false)
	if err != nil {
		t.Fatal(err)
	}
	if diff.Diff == "" || !containsAll(diff.Diff, "-one", "+two") {
		t.Fatalf("diff=%q", diff.Diff)
	}

	udiff, err := collectGitDiff(root, "fresh.txt", false)
	if err != nil {
		t.Fatal(err)
	}
	if udiff.Diff == "" || !containsAll(udiff.Diff, "+new") {
		t.Fatalf("untracked diff=%q", udiff.Diff)
	}
}

func TestLocalNameFromRemoteRef(t *testing.T) {
	got, err := localNameFromRemoteRef("origin/feature/x")
	if err != nil || got != "feature/x" {
		t.Fatalf("got=%q err=%v", got, err)
	}
}

func TestValidateGitRelPathAndRef(t *testing.T) {
	if err := validateGitRelPath("../x"); err == nil {
		t.Fatal("expected path rejection")
	}
	if err := validateGitRefName("-evil"); err == nil {
		t.Fatal("expected ref rejection")
	}
	if err := validateGitRelPath("src/a.go"); err != nil {
		t.Fatal(err)
	}
	if err := validateGitRefName("feature/x"); err != nil {
		t.Fatal(err)
	}
}

func TestCollectGitCheckoutIntegration(t *testing.T) {
	root := initTestRepo(t)
	if _, err := collectGitCheckout(root, "develop", GitRefLocalBranch); err != nil {
		t.Fatal(err)
	}
	if got := ResolveGitBranch(root); got != "develop" {
		t.Fatalf("branch=%q", got)
	}
	if _, err := collectGitCheckout(root, "v0.1.0", GitRefTag); err != nil {
		t.Fatal(err)
	}
	if got := ResolveGitBranch(root); got != "" {
		t.Fatalf("expected detached, branch=%q", got)
	}
}

func TestCollectGitShowIntegration(t *testing.T) {
	root := initTestRepo(t)
	got, err := collectGitShow(root, "tracked.txt", "HEAD")
	if err != nil {
		t.Fatal(err)
	}
	if !got.Exists || got.Content != "one\n" {
		t.Fatalf("show=%+v", got)
	}
	missing, err := collectGitShow(root, "nope.txt", "HEAD")
	if err != nil {
		t.Fatal(err)
	}
	if missing.Exists {
		t.Fatalf("expected missing: %+v", missing)
	}
}

func TestCollectGitRefsIntegration(t *testing.T) {
	root := initTestRepo(t)
	refs, err := collectGitRefs(root)
	if err != nil {
		t.Fatal(err)
	}
	if !refs.IsRepo {
		t.Fatal("expected repo")
	}
	locals := map[string]GitRefEntry{}
	for _, r := range refs.LocalBranches {
		locals[r.Name] = r
	}
	if !locals["main"].IsCurrent {
		t.Fatalf("main should be current: %+v", refs.LocalBranches)
	}
	if _, ok := locals["develop"]; !ok {
		t.Fatalf("missing develop: %+v", refs.LocalBranches)
	}
	foundTag := false
	for _, tag := range refs.Tags {
		if tag.Name == "v0.1.0" {
			foundTag = true
			if tag.Tip == "" {
				t.Fatal("tag tip empty")
			}
		}
	}
	if !foundTag {
		t.Fatalf("missing tag: %+v", refs.Tags)
	}
}

func containsAll(s string, parts ...string) bool {
	for _, p := range parts {
		if !strings.Contains(s, p) {
			return false
		}
	}
	return true
}
