package vfs

import (
	"fmt"
	"sync"
	"testing"
	"time"
)

func TestCoalescerEmitsSmallBurstIndividually(t *testing.T) {
	var mu sync.Mutex
	var got []DidChangeParams
	c := coalescer{
		delay:     25 * time.Millisecond,
		bulkAfter: 8,
		flush: func(p DidChangeParams) {
			mu.Lock()
			got = append(got, p)
			mu.Unlock()
		},
	}
	c.push(DidChangeParams{Path: "a.go", Type: ChangeWrite})
	c.push(DidChangeParams{Path: "b.go", Type: ChangeWrite})
	time.Sleep(80 * time.Millisecond)

	mu.Lock()
	defer mu.Unlock()
	if len(got) != 2 {
		t.Fatalf("expected 2 events, got %+v", got)
	}
	if got[0].Path != "a.go" || got[1].Path != "b.go" {
		t.Fatalf("unexpected events %+v", got)
	}
}

func TestCoalescerCollapsesBulkToSync(t *testing.T) {
	var mu sync.Mutex
	var got []DidChangeParams
	c := coalescer{
		delay:     25 * time.Millisecond,
		bulkAfter: 4,
		flush: func(p DidChangeParams) {
			mu.Lock()
			got = append(got, p)
			mu.Unlock()
		},
	}
	for i := 0; i < 10; i++ {
		c.push(DidChangeParams{Path: fmt.Sprintf("%d.go", i), Type: ChangeWrite})
	}
	time.Sleep(80 * time.Millisecond)

	mu.Lock()
	defer mu.Unlock()
	if len(got) != 1 || got[0].Type != ChangeSync || got[0].Path != "." {
		t.Fatalf("expected one sync, got %+v", got)
	}
}

func TestCoalescerDiscardDropsPending(t *testing.T) {
	var n int
	c := coalescer{
		delay:     40 * time.Millisecond,
		bulkAfter: 8,
		flush:     func(DidChangeParams) { n++ },
	}
	c.push(DidChangeParams{Path: "a.go", Type: ChangeWrite})
	c.discard()
	time.Sleep(80 * time.Millisecond)
	if n != 0 {
		t.Fatalf("discarded coalescer still flushed %d events", n)
	}
}
