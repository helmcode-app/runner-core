package vfs

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestRPCInitializeReadWrite(t *testing.T) {
	root := t.TempDir()
	_ = os.WriteFile(filepath.Join(root, "a.txt"), []byte("one"), 0o644)

	var stdin bytes.Buffer
	writeReq(&stdin, 1, "vfs/initialize", map[string]string{"root": root})
	writeReq(&stdin, 2, "vfs/read", map[string]string{"path": "a.txt"})
	writeReq(&stdin, 3, "vfs/write", map[string]any{"path": "b.txt", "content": "two"})
	writeReq(&stdin, 4, "vfs/read", map[string]string{"path": "b.txt"})
	writeReq(&stdin, 5, "vfs/read_chunk", map[string]any{"path": "b.txt", "offset": 0, "limit": 2})
	writeReq(&stdin, 6, "vfs/read_chunk", map[string]any{"path": "b.txt", "offset": 2, "limit": 64})
	writeReq(&stdin, 7, "vfs/shutdown", nil)

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	done := make(chan error, 1)
	go func() {
		done <- Serve(&stdin, &stdout, &stderr, root)
	}()

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("serve: %v stderr=%s", err, stderr.String())
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timeout")
	}

	byID := map[float64]Response{}
	dec := json.NewDecoder(bytes.NewReader(stdout.Bytes()))
	for dec.More() {
		var raw map[string]json.RawMessage
		if err := dec.Decode(&raw); err != nil {
			t.Fatal(err)
		}
		if _, ok := raw["id"]; !ok {
			continue // notification
		}
		b, _ := json.Marshal(raw)
		var resp Response
		if err := json.Unmarshal(b, &resp); err != nil {
			t.Fatal(err)
		}
		var id float64
		_ = json.Unmarshal(resp.ID, &id)
		byID[id] = resp
	}

	for _, id := range []float64{1, 2, 3, 4, 5, 6, 7} {
		if _, ok := byID[id]; !ok {
			t.Fatalf("missing response id=%v out=%s", id, stdout.String())
		}
		if byID[id].Error != nil {
			t.Fatalf("id=%v error=%+v", id, byID[id].Error)
		}
	}

	raw, _ := json.Marshal(byID[1].Result)
	var init InitializeResult
	_ = json.Unmarshal(raw, &init)
	if len(init.Entries) < 1 {
		t.Fatalf("entries empty: %+v", init)
	}
	if init.Name == "" {
		t.Fatal("expected non-empty project name")
	}

	raw, _ = json.Marshal(byID[2].Result)
	var rr ReadResult
	_ = json.Unmarshal(raw, &rr)
	if rr.Content != "one" {
		t.Fatalf("read a content=%q", rr.Content)
	}

	raw, _ = json.Marshal(byID[4].Result)
	_ = json.Unmarshal(raw, &rr)
	if rr.Content != "two" {
		t.Fatalf("read b content=%q out=%s", rr.Content, stdout.String())
	}

	raw, _ = json.Marshal(byID[5].Result)
	var c1 ReadChunkResult
	_ = json.Unmarshal(raw, &c1)
	if c1.Content != "tw" || c1.IsEOF {
		t.Fatalf("chunk1=%+v", c1)
	}
	raw, _ = json.Marshal(byID[6].Result)
	var c2 ReadChunkResult
	_ = json.Unmarshal(raw, &c2)
	if c2.Content != "o" || !c2.IsEOF {
		t.Fatalf("chunk2=%+v", c2)
	}
}

func TestReadChunkDoesNotLoadWholeFile(t *testing.T) {
	root := t.TempDir()
	// 512 KiB of 'x' — larger than MaxFullReadBytes for vfs/read.
	big := bytes.Repeat([]byte("x"), 512*1024)
	_ = os.WriteFile(filepath.Join(root, "big.bin"), big, 0o644)

	var stdin bytes.Buffer
	writeReq(&stdin, 1, "vfs/read", map[string]string{"path": "big.bin"})
	writeReq(&stdin, 2, "vfs/read_chunk", map[string]any{
		"path": "big.bin", "offset": 0, "limit": 64,
	})
	writeReq(&stdin, 3, "vfs/shutdown", nil)

	var stdout, stderr bytes.Buffer
	done := make(chan error, 1)
	go func() { done <- Serve(&stdin, &stdout, &stderr, root) }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timeout")
	}

	byID := map[float64]Response{}
	dec := json.NewDecoder(bytes.NewReader(stdout.Bytes()))
	for dec.More() {
		var raw map[string]json.RawMessage
		if err := dec.Decode(&raw); err != nil {
			t.Fatal(err)
		}
		if _, ok := raw["id"]; !ok {
			continue
		}
		b, _ := json.Marshal(raw)
		var resp Response
		_ = json.Unmarshal(b, &resp)
		var id float64
		_ = json.Unmarshal(resp.ID, &id)
		byID[id] = resp
	}

	if byID[1].Error == nil {
		t.Fatal("expected vfs/read to reject large file")
	}
	if byID[2].Error != nil {
		t.Fatalf("chunk err: %+v", byID[2].Error)
	}
	raw, _ := json.Marshal(byID[2].Result)
	var chunk ReadChunkResult
	_ = json.Unmarshal(raw, &chunk)
	if chunk.BytesRead != 64 || len(chunk.Content) != 64 {
		t.Fatalf("unexpected chunk: %+v", chunk)
	}
}

func writeReq(w *bytes.Buffer, id int, method string, params any) {
	req := map[string]any{
		"jsonrpc": "2.0",
		"id":      id,
		"method":  method,
	}
	if params != nil {
		req["params"] = params
	}
	b, _ := json.Marshal(req)
	w.Write(b)
	w.WriteByte('\n')
}
