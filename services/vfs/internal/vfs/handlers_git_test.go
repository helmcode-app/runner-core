package vfs

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestRPCGitStatusRefsDiffShow(t *testing.T) {
	root := initTestRepo(t)
	_ = os.WriteFile(filepath.Join(root, "tracked.txt"), []byte("two\n"), 0o644)

	var stdin bytes.Buffer
	writeReq(&stdin, 1, MethodGitStatus, map[string]any{})
	writeReq(&stdin, 2, MethodGitRefs, map[string]any{})
	writeReq(&stdin, 3, MethodGitDiff, map[string]any{"path": "tracked.txt"})
	writeReq(&stdin, 4, MethodGitShow, map[string]any{"path": "tracked.txt", "revision": "HEAD"})
	writeReq(&stdin, 5, MethodShutdown, nil)

	byID := serveRPC(t, root, &stdin)
	for _, id := range []float64{1, 2, 3, 4, 5} {
		if byID[id].Error != nil {
			t.Fatalf("id=%v err=%+v", id, byID[id].Error)
		}
	}

	raw, _ := json.Marshal(byID[1].Result)
	var st GitStatusResult
	_ = json.Unmarshal(raw, &st)
	if !st.IsRepo || st.Branch != "main" || len(st.Changes) == 0 {
		t.Fatalf("status=%+v", st)
	}

	raw, _ = json.Marshal(byID[2].Result)
	var refs GitRefsResult
	_ = json.Unmarshal(raw, &refs)
	if len(refs.LocalBranches) == 0 || len(refs.Tags) == 0 {
		t.Fatalf("refs=%+v", refs)
	}

	raw, _ = json.Marshal(byID[3].Result)
	var diff GitDiffResult
	_ = json.Unmarshal(raw, &diff)
	if diff.Diff == "" {
		t.Fatalf("diff empty: %+v", diff)
	}

	raw, _ = json.Marshal(byID[4].Result)
	var show GitShowResult
	_ = json.Unmarshal(raw, &show)
	if !show.Exists || show.Content != "one\n" {
		t.Fatalf("show=%+v", show)
	}
}

func TestRPCGitCheckout(t *testing.T) {
	root := initTestRepo(t)

	var stdin bytes.Buffer
	writeReq(&stdin, 1, MethodGitCheckout, map[string]any{"ref": "develop", "kind": GitRefLocalBranch})
	writeReq(&stdin, 2, MethodShutdown, nil)

	byID := serveRPC(t, root, &stdin)
	if byID[1].Error != nil {
		t.Fatalf("checkout err=%+v", byID[1].Error)
	}
	raw, _ := json.Marshal(byID[1].Result)
	var co GitCheckoutResult
	_ = json.Unmarshal(raw, &co)
	if co.Branch != "develop" || co.Detached {
		t.Fatalf("checkout=%+v", co)
	}
}

func serveRPC(t *testing.T, root string, stdin *bytes.Buffer) map[float64]Response {
	t.Helper()
	var stdout, stderr bytes.Buffer
	done := make(chan error, 1)
	go func() { done <- Serve(stdin, &stdout, &stderr, root) }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("serve: %v stderr=%s", err, stderr.String())
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timeout")
	}
	return decodeRPCResponses(t, stdout.Bytes())
}

func decodeRPCResponses(t *testing.T, data []byte) map[float64]Response {
	t.Helper()
	byID := map[float64]Response{}
	dec := json.NewDecoder(bytes.NewReader(data))
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
	return byID
}
