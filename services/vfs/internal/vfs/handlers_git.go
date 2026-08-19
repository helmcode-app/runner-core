package vfs

import (
	"encoding/json"
	"strings"
)

func registerGitHandlers(m map[string]handlerFunc) {
	m[MethodGitStatus] = (*Server).handleGitStatus
	m[MethodGitRefs] = (*Server).handleGitRefs
	m[MethodGitDiff] = (*Server).handleGitDiff
	m[MethodGitShow] = (*Server).handleGitShow
	m[MethodGitCheckout] = (*Server).handleGitCheckout
}

func (s *Server) handleGitStatus(_ json.RawMessage) (any, error) {
	res, err := collectGitStatus(s.root)
	if err != nil {
		return nil, rpcErr(CodeInternalError, err.Error())
	}
	return res, nil
}

func (s *Server) handleGitRefs(_ json.RawMessage) (any, error) {
	res, err := collectGitRefs(s.root)
	if err != nil {
		return nil, rpcErr(CodeInternalError, err.Error())
	}
	return res, nil
}

type gitDiffParams struct {
	Path   string `json:"path"`
	Staged bool   `json:"staged"`
}

func (s *Server) handleGitDiff(params json.RawMessage) (any, error) {
	var p gitDiffParams
	if err := json.Unmarshal(params, &p); err != nil || p.Path == "" {
		return nil, rpcErr(CodeInvalidParams, "path is required")
	}
	_, rel, err := resolveSafe(s.root, p.Path)
	if err != nil {
		return nil, rpcErr(CodeInvalidParams, err.Error())
	}
	res, err := collectGitDiff(s.root, rel, p.Staged)
	if err != nil {
		return nil, rpcErr(CodeInternalError, err.Error())
	}
	return res, nil
}

type gitShowParams struct {
	Path     string `json:"path"`
	Revision string `json:"revision"`
}

func (s *Server) handleGitShow(params json.RawMessage) (any, error) {
	var p gitShowParams
	if err := json.Unmarshal(params, &p); err != nil || p.Path == "" {
		return nil, rpcErr(CodeInvalidParams, "path is required")
	}
	_, rel, err := resolveSafe(s.root, p.Path)
	if err != nil {
		return nil, rpcErr(CodeInvalidParams, err.Error())
	}
	res, err := collectGitShow(s.root, rel, p.Revision)
	if err != nil {
		return nil, rpcErr(CodeInternalError, err.Error())
	}
	return res, nil
}

type gitCheckoutParams struct {
	Ref  string `json:"ref"`
	Kind string `json:"kind"`
}

func (s *Server) handleGitCheckout(params json.RawMessage) (any, error) {
	var p gitCheckoutParams
	if err := json.Unmarshal(params, &p); err != nil || strings.TrimSpace(p.Ref) == "" {
		return nil, rpcErr(CodeInvalidParams, "ref is required")
	}
	if strings.TrimSpace(p.Kind) == "" {
		return nil, rpcErr(CodeInvalidParams, "kind is required")
	}
	var res GitCheckoutResult
	err := s.suppressDidChange(func() error {
		var inner error
		res, inner = collectGitCheckout(s.root, p.Ref, p.Kind)
		return inner
	})
	if err != nil {
		return nil, rpcErr(CodeInternalError, err.Error())
	}
	return res, nil
}
