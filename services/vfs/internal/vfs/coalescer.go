package vfs

import (
	"sync"
	"time"
)

const (
	// Quiet window after the last fsnotify event. Single-file saves wait this
	// long; a git switch keeps resetting the timer until the worktree settles.
	coalesceIdle = 120 * time.Millisecond
	// Once this many events pile up in one window, flush a single ChangeSync
	// instead of one didChange per file (Terminal `git switch`).
	coalesceBulkAfter = 16
	// Drop leftover inotify after vfs/gitCheckout returns.
	quietDrain = 200 * time.Millisecond
)

func bulkSyncParams() DidChangeParams {
	return DidChangeParams{Path: ".", Type: ChangeSync}
}

type coalescer struct {
	mu        sync.Mutex
	pending   []DidChangeParams
	bulk      bool
	timer     *time.Timer
	delay     time.Duration
	bulkAfter int
	flush     func(DidChangeParams)
}

func newCoalescer(flush func(DidChangeParams)) coalescer {
	return coalescer{
		delay:     coalesceIdle,
		bulkAfter: coalesceBulkAfter,
		flush:     flush,
	}
}

func (c *coalescer) push(p DidChangeParams) {
	if c.flush == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.delay == 0 {
		c.delay = coalesceIdle
	}
	if c.bulkAfter <= 0 {
		c.bulkAfter = coalesceBulkAfter
	}
	c.pending = append(c.pending, p)
	if len(c.pending) >= c.bulkAfter {
		c.bulk = true
	}
	if c.timer == nil {
		c.timer = time.AfterFunc(c.delay, c.fire)
	} else {
		c.timer.Reset(c.delay)
	}
}

func (c *coalescer) fire() {
	pending, bulk, flush := c.take()
	if flush == nil || len(pending) == 0 {
		return
	}
	if bulk {
		flush(bulkSyncParams())
		return
	}
	for _, p := range pending {
		flush(p)
	}
}

func (c *coalescer) discard() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.stopTimerLocked()
	c.pending = nil
	c.bulk = false
}

func (c *coalescer) take() (pending []DidChangeParams, bulk bool, flush func(DidChangeParams)) {
	c.mu.Lock()
	defer c.mu.Unlock()
	pending = c.pending
	bulk = c.bulk
	flush = c.flush
	c.pending = nil
	c.bulk = false
	c.stopTimerLocked()
	return
}

func (c *coalescer) stopTimerLocked() {
	if c.timer == nil {
		return
	}
	c.timer.Stop()
	c.timer = nil
}
