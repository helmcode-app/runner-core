package vfs

import (
	"encoding/json"
	"fmt"
	"os"
)

type initializeParams struct {
	Root string `json:"root,omitempty"`
}

type pathParams struct {
	Path string `json:"path"`
}

type writeParams struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

type handlerFunc func(s *Server, params json.RawMessage) (any, error)

func defaultHandlers() map[string]handlerFunc {
	return map[string]handlerFunc{
		MethodInitialize: (*Server).handleInitialize,
		MethodRead:       (*Server).handleRead,
		MethodWrite:      (*Server).handleWrite,
		MethodShutdown:   (*Server).handleShutdown,
	}
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
		Entries: entries,
	}, nil
}

func (s *Server) handleRead(params json.RawMessage) (any, error) {
	var p pathParams
	if err := json.Unmarshal(params, &p); err != nil || p.Path == "" {
		return nil, rpcErr(CodeInvalidParams, "path is required")
	}
	abs, rel, err := resolveSafe(s.root, p.Path)
	if err != nil {
		return nil, rpcErr(CodeInvalidParams, err.Error())
	}
	data, err := os.ReadFile(abs)
	if err != nil {
		return nil, rpcErr(CodeInternalError, err.Error())
	}
	return ReadResult{Path: rel, Content: string(data), Size: len(data)}, nil
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
