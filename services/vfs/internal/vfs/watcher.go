package vfs

import (
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"sync"

	"github.com/fsnotify/fsnotify"
)

// Watcher recursively watches root via fsnotify (inotify on Linux).
type Watcher struct {
	root    string
	w       *fsnotify.Watcher
	onEvent func(DidChangeParams)
	log     *log.Logger
	mu      sync.Mutex
	closed  bool
}

func NewWatcher(root string, onEvent func(DidChangeParams), logger *log.Logger) (*Watcher, error) {
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	w, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}
	tw := &Watcher{
		root:    rootAbs,
		w:       w,
		onEvent: onEvent,
		log:     logger,
	}
	if err := tw.addTree(rootAbs); err != nil {
		_ = w.Close()
		return nil, err
	}
	go tw.loop()
	return tw, nil
}

func (tw *Watcher) Close() error {
	tw.mu.Lock()
	defer tw.mu.Unlock()
	if tw.closed {
		return nil
	}
	tw.closed = true
	return tw.w.Close()
}

func (tw *Watcher) addTree(dir string) error {
	return filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if !d.IsDir() {
			return nil
		}
		if path != tw.root && isIgnoredName(d.Name()) {
			return fs.SkipDir
		}
		if err := tw.w.Add(path); err != nil {
			tw.log.Printf("watch add %s: %v", path, err)
		}
		return nil
	})
}

func (tw *Watcher) loop() {
	for {
		select {
		case err, ok := <-tw.w.Errors:
			if !ok {
				return
			}
			tw.log.Printf("fsnotify error: %v", err)
		case ev, ok := <-tw.w.Events:
			if !ok {
				return
			}
			tw.handle(ev)
		}
	}
}

func (tw *Watcher) handle(ev fsnotify.Event) {
	// Ignore chmod-only noise.
	if ev.Has(fsnotify.Chmod) && !ev.Has(fsnotify.Write) && !ev.Has(fsnotify.Create) &&
		!ev.Has(fsnotify.Remove) && !ev.Has(fsnotify.Rename) {
		return
	}

	rel, err := filepath.Rel(tw.root, ev.Name)
	if err != nil || rel == "." {
		return
	}
	rel = filepath.ToSlash(rel)
	if pathHasIgnoredSegment(rel) {
		return
	}

	ctype, ok := changeTypeFromEvent(ev)
	if !ok {
		return
	}
	if ctype == ChangeCreate {
		if info, err := os.Stat(ev.Name); err == nil && info.IsDir() {
			_ = tw.w.Add(ev.Name)
			_ = tw.addTree(ev.Name)
		}
	}

	if tw.onEvent != nil {
		tw.log.Printf("didChange type=%s path=%s", ctype, rel)
		tw.onEvent(DidChangeParams{Path: rel, Type: ctype})
	}
}

func changeTypeFromEvent(ev fsnotify.Event) (ChangeType, bool) {
	switch {
	case ev.Has(fsnotify.Create):
		return ChangeCreate, true
	case ev.Has(fsnotify.Write):
		return ChangeWrite, true
	case ev.Has(fsnotify.Remove):
		return ChangeRemove, true
	case ev.Has(fsnotify.Rename):
		return ChangeRename, true
	default:
		return "", false
	}
}
