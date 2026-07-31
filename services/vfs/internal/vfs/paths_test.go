package vfs

import (
	"os"
	"path/filepath"
	"testing"
)

func TestResolveSafe(t *testing.T) {
	root := t.TempDir()
	abs, rel, err := resolveSafe(root, "pkg/a.go")
	if err != nil {
		t.Fatal(err)
	}
	if rel != "pkg/a.go" {
		t.Fatalf("rel=%q", rel)
	}
	want := filepath.Join(root, "pkg", "a.go")
	if abs != want {
		t.Fatalf("abs=%q want %q", abs, want)
	}
}

func TestResolveSafeRejectsEscape(t *testing.T) {
	root := t.TempDir()
	if _, _, err := resolveSafe(root, "../etc/passwd"); err == nil {
		t.Fatal("expected error")
	}
	if _, _, err := resolveSafe(root, "/etc/passwd"); err == nil {
		t.Fatal("expected error")
	}
}

func TestScanTreeIgnoresGit(t *testing.T) {
	root := t.TempDir()
	_ = os.MkdirAll(filepath.Join(root, ".git"), 0o755)
	_ = os.WriteFile(filepath.Join(root, ".git", "config"), []byte("x"), 0o644)
	_ = os.WriteFile(filepath.Join(root, "README.md"), []byte("hi"), 0o644)
	_ = os.MkdirAll(filepath.Join(root, "pkg"), 0o755)
	_ = os.WriteFile(filepath.Join(root, "pkg", "a.go"), []byte("package pkg"), 0o644)

	entries, err := ScanTree(root)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if e.Path == ".git" || e.Path == ".git/config" {
			t.Fatalf("git path leaked: %+v", e)
		}
	}
	found := map[string]bool{}
	for _, e := range entries {
		found[e.Path] = true
	}
	if !found["README.md"] || !found["pkg"] || !found["pkg/a.go"] {
		t.Fatalf("missing entries: %+v", entries)
	}
}

func TestAtomicWriteFile(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "nested", "f.txt")
	if err := atomicWriteFile(path, []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != "hello" {
		t.Fatalf("content=%q", b)
	}
}
