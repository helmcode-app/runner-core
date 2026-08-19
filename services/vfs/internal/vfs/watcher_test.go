package vfs

import (
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestWatcherQuietDropsEvents(t *testing.T) {
	root := t.TempDir()
	var n atomic.Int32
	logger := log.New(io.Discard, "", 0)
	w, err := NewWatcher(root, func(DidChangeParams) { n.Add(1) }, logger)
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()
	time.Sleep(50 * time.Millisecond)

	w.SetQuiet(true)
	if err := os.WriteFile(filepath.Join(root, "quiet.txt"), []byte("a"), 0o644); err != nil {
		t.Fatal(err)
	}
	time.Sleep(250 * time.Millisecond)
	if got := n.Load(); got != 0 {
		t.Fatalf("quiet watcher emitted %d events", got)
	}

	w.SetQuiet(false)
	if err := os.WriteFile(filepath.Join(root, "loud.txt"), []byte("b"), 0o644); err != nil {
		t.Fatal(err)
	}
	if !waitUntil(t, 2*time.Second, func() bool { return n.Load() >= 1 }) {
		t.Fatal("expected didChange after unquiet")
	}
}

func TestIsGitHeadRel(t *testing.T) {
	if !isGitHeadRel(gitHeadRel) {
		t.Fatal("expected HEAD")
	}
	if isGitHeadRel(".git/HEAD.lock") || isGitHeadRel(".git/config") || isGitHeadRel("pkg/a.go") {
		t.Fatal("unexpected HEAD match")
	}
}

func TestWatcherEmitsGitHead(t *testing.T) {
	root := t.TempDir()
	gitDir := filepath.Join(root, ".git")
	if err := os.Mkdir(gitDir, 0o755); err != nil {
		t.Fatal(err)
	}
	head := filepath.Join(gitDir, "HEAD")
	if err := os.WriteFile(head, []byte("ref: refs/heads/main\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	var got atomic.Value
	got.Store("")
	logger := log.New(io.Discard, "", 0)
	w, err := NewWatcher(root, func(p DidChangeParams) {
		got.Store(p.Path)
	}, logger)
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()
	time.Sleep(50 * time.Millisecond)

	if err := os.WriteFile(head, []byte("ref: refs/heads/develop\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if !waitUntil(t, 2*time.Second, func() bool { return got.Load().(string) == gitHeadRel }) {
		t.Fatalf("expected .git/HEAD didChange, got %q", got.Load().(string))
	}
}

func TestWatcherCoalescesBulkWrites(t *testing.T) {
	root := t.TempDir()
	var mu sync.Mutex
	var got []DidChangeParams
	logger := log.New(io.Discard, "", 0)
	w, err := NewWatcher(root, func(p DidChangeParams) {
		mu.Lock()
		got = append(got, p)
		mu.Unlock()
	}, logger)
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()
	time.Sleep(50 * time.Millisecond)

	for i := 0; i < 24; i++ {
		name := filepath.Join(root, fmt.Sprintf("f%d.txt", i))
		if err := os.WriteFile(name, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	ok := waitUntil(t, 2*time.Second, func() bool {
		mu.Lock()
		snapshot := append([]DidChangeParams(nil), got...)
		mu.Unlock()
		if len(snapshot) < 1 || len(snapshot) > 3 {
			return false
		}
		for _, p := range snapshot {
			if p.Type != ChangeSync {
				return false
			}
		}
		return true
	})
	if !ok {
		mu.Lock()
		defer mu.Unlock()
		t.Fatalf("expected one sync didChange, got %+v", got)
	}
}

func waitUntil(t *testing.T, d time.Duration, ok func() bool) bool {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if ok() {
			return true
		}
		time.Sleep(20 * time.Millisecond)
	}
	return false
}
