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
	// quiet drops didChange emissions (git checkout / bulk writes) while still
	// attaching watches for new directories.
	quiet bool
	coal  coalescer
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
	tw.coal = newCoalescer(tw.dispatch)
	if err := tw.addTree(rootAbs); err != nil {
		_ = w.Close()
		return nil, err
	}
	tw.addGitDirWatch()
	go tw.loop()
	return tw, nil
}

func (tw *Watcher) Close() error {
	tw.mu.Lock()
	if tw.closed {
		tw.mu.Unlock()
		return nil
	}
	tw.closed = true
	tw.mu.Unlock()
	tw.coal.discard()
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

// Watch `.git` itself (not objects/) so Terminal `git switch` still notifies via HEAD.
func (tw *Watcher) addGitDirWatch() {
	gitDir := filepath.Join(tw.root, ".git")
	st, err := os.Stat(gitDir)
	if err != nil || !st.IsDir() {
		return
	}
	if err := tw.w.Add(gitDir); err != nil {
		tw.log.Printf("watch add %s: %v", gitDir, err)
	}
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
	if isChmodOnly(ev) {
		return
	}

	rel, err := filepath.Rel(tw.root, ev.Name)
	if err != nil || rel == "." {
		return
	}
	rel = filepath.ToSlash(rel)

	// `.git` is ignored in the file tree, but Terminal `git switch` only
	// updates HEAD when the worktree is unchanged. Surface that one file.
	if isGitHeadRel(rel) {
		tw.emit(DidChangeParams{Path: gitHeadRel, Type: ChangeWrite})
		return
	}

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

	tw.emit(DidChangeParams{Path: rel, Type: ctype})
}

func (tw *Watcher) emit(params DidChangeParams) {
	if !tw.live() {
		return
	}
	tw.coal.push(params)
}

func (tw *Watcher) dispatch(params DidChangeParams) {
	onEvent, ok := tw.listener()
	if !ok {
		return
	}
	tw.log.Printf("didChange type=%s path=%s", params.Type, params.Path)
	onEvent(params)
}

func (tw *Watcher) live() bool {
	_, ok := tw.listener()
	return ok
}

func (tw *Watcher) listener() (func(DidChangeParams), bool) {
	tw.mu.Lock()
	defer tw.mu.Unlock()
	if tw.quiet || tw.closed || tw.onEvent == nil {
		return nil, false
	}
	return tw.onEvent, true
}

// SetQuiet suppresses vfs/didChange while git checkout (or similar) rewrites the tree.
func (tw *Watcher) SetQuiet(quiet bool) {
	if tw == nil {
		return
	}
	tw.mu.Lock()
	tw.quiet = quiet
	tw.mu.Unlock()
	if quiet {
		tw.coal.discard()
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

func isChmodOnly(ev fsnotify.Event) bool {
	return ev.Has(fsnotify.Chmod) && !ev.Has(fsnotify.Write) && !ev.Has(fsnotify.Create) &&
		!ev.Has(fsnotify.Remove) && !ev.Has(fsnotify.Rename)
}
