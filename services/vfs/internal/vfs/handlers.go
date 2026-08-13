package vfs

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
)

type initializeParams struct {
	Root string `json:"root,omitempty"`
}

type pathParams struct {
	Path string `json:"path"`
}

type readChunkParams struct {
	Path   string `json:"path"`
	Offset int64  `json:"offset"`
	// Limit is max bytes to read; 0 → DefaultChunkLimit.
	Limit int `json:"limit"`
}

type writeParams struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

type handlerFunc func(s *Server, params json.RawMessage) (any, error)

func defaultHandlers() map[string]handlerFunc {
	m := map[string]handlerFunc{
		MethodInitialize: (*Server).handleInitialize,
		MethodRead:       (*Server).handleRead,
		MethodReadChunk:  (*Server).handleReadChunk,
		MethodWrite:      (*Server).handleWrite,
		MethodShutdown:   (*Server).handleShutdown,
	}
	registerGitHandlers(m)
	return m
}

func (s *Server) handleInitialize(params json.RawMessage) (any, error) {
	var p initializeParams
	if len(params) > 0 {
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, rpcErr(CodeInvalidParams, "invalid initialize params")
		}
	}
	if p.Root != "" {
		if err := s.setRoot(p.Root); err != nil {
			return nil, rpcErr(CodeInternalError, err.Error())
		}
	}
	entries, err := ScanTree(s.root)
	if err != nil {
		return nil, rpcErr(CodeInternalError, fmt.Sprintf("scan tree: %v", err))
	}
	return InitializeResult{
		Root:    s.root,
		Name:    ResolveProjectName(s.root),
		Remote:  ResolveGitRemote(s.root),
		Branch:  ResolveGitBranch(s.root),
		Entries: entries,
	}, nil
}

// handleRead loads small files only (≤ MaxFullReadBytes) via ReadAt — never os.ReadFile.
// Large files must use vfs/read_chunk.
func (s *Server) handleRead(params json.RawMessage) (any, error) {
	var p pathParams
	if err := json.Unmarshal(params, &p); err != nil || p.Path == "" {
		return nil, rpcErr(CodeInvalidParams, "path is required")
	}
	abs, rel, err := resolveSafe(s.root, p.Path)
	if err != nil {
		return nil, rpcErr(CodeInvalidParams, err.Error())
	}

	f, err := os.Open(abs)
	if err != nil {
		return nil, rpcErr(CodeInternalError, err.Error())
	}
	defer f.Close()

	st, err := f.Stat()
	if err != nil {
		return nil, rpcErr(CodeInternalError, err.Error())
	}
	size := st.Size()
	if size > MaxFullReadBytes {
		return nil, rpcErr(
			CodeInvalidParams,
			fmt.Sprintf(
				"file too large for vfs/read (%d bytes); use vfs/read_chunk (max full read %d)",
				size,
				MaxFullReadBytes,
			),
		)
	}
	if size == 0 {
		return ReadResult{Path: rel, Content: "", Size: 0}, nil
	}

	buf := make([]byte, int(size))
	n, err := f.ReadAt(buf, 0)
	if err != nil && err != io.EOF {
		return nil, rpcErr(CodeInternalError, err.Error())
	}
	buf = buf[:n]
	return ReadResult{Path: rel, Content: string(buf), Size: n}, nil
}

// handleReadChunk reads a bounded window via file.ReadAt (kernel segment fetch).
func (s *Server) handleReadChunk(params json.RawMessage) (any, error) {
	var p readChunkParams
	if err := json.Unmarshal(params, &p); err != nil || p.Path == "" {
		return nil, rpcErr(CodeInvalidParams, "path is required")
	}
	if p.Offset < 0 {
		return nil, rpcErr(CodeInvalidParams, "offset must be >= 0")
	}

	limit := p.Limit
	if limit <= 0 {
		limit = DefaultChunkLimit
	}
	if limit > MaxChunkLimit {
		limit = MaxChunkLimit
	}

	abs, rel, err := resolveSafe(s.root, p.Path)
	if err != nil {
		return nil, rpcErr(CodeInvalidParams, err.Error())
	}

	f, err := os.Open(abs)
	if err != nil {
		return nil, rpcErr(CodeInternalError, err.Error())
	}
	defer f.Close()

	st, err := f.Stat()
	if err != nil {
		return nil, rpcErr(CodeInternalError, err.Error())
	}
	fileSize := st.Size()

	if p.Offset >= fileSize {
		return ReadChunkResult{
			Path:      rel,
			Content:   "",
			Offset:    p.Offset,
			BytesRead: 0,
			IsEOF:     true,
			FileSize:  fileSize,
		}, nil
	}

	// Bound buffer strictly to limit (never allocate full file).
	buf := make([]byte, limit)
	n, err := f.ReadAt(buf, p.Offset)
	isEOF := false
	if err == io.EOF {
		isEOF = true
		err = nil
	}
	if err != nil {
		return nil, rpcErr(CodeInternalError, err.Error())
	}
	buf = buf[:n]

	// EOF when short read or next offset at/ past end.
	if int64(n) < int64(limit) || p.Offset+int64(n) >= fileSize {
		isEOF = true
	}

	return ReadChunkResult{
		Path:      rel,
		Content:   string(buf),
		Offset:    p.Offset,
		BytesRead: n,
		IsEOF:     isEOF,
		FileSize:  fileSize,
	}, nil
}

func (s *Server) handleWrite(params json.RawMessage) (any, error) {
	var p writeParams
	if err := json.Unmarshal(params, &p); err != nil || p.Path == "" {
		return nil, rpcErr(CodeInvalidParams, "path and content are required")
	}
	abs, rel, err := resolveSafe(s.root, p.Path)
	if err != nil {
		return nil, rpcErr(CodeInvalidParams, err.Error())
	}
	if err := atomicWriteFile(abs, []byte(p.Content), 0o644); err != nil {
		return nil, rpcErr(CodeInternalError, err.Error())
	}
	return WriteResult{Path: rel, Size: len(p.Content)}, nil
}

func (s *Server) handleShutdown(_ json.RawMessage) (any, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.watcher != nil {
		_ = s.watcher.Close()
		s.watcher = nil
	}
	return map[string]bool{"ok": true}, nil
}
