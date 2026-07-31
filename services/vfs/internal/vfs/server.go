package vfs

import (
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"sync"
)

// Server is the stdin/stdout JSON-RPC VFS engine.
type Server struct {
	root     string
	out      *Stream
	log      *log.Logger
	watcher  *Watcher
	handlers map[string]handlerFunc
	mu       sync.Mutex
}

// Serve runs the VFS event loop until stdin closes.
func Serve(in io.Reader, out io.Writer, errW io.Writer, root string) error {
	logger := log.New(errW, "helm-vfs: ", log.LstdFlags|log.Lmsgprefix)
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return err
	}
	if st, err := os.Stat(rootAbs); err != nil {
		// Allow missing root at boot; initialize may set a valid root later.
		logger.Printf("root %s not ready: %v (waiting for %s)", rootAbs, err, MethodInitialize)
	} else if !st.IsDir() {
		return fmt.Errorf("root is not a directory: %s", rootAbs)
	}

	s := &Server{
		root:     rootAbs,
		out:      NewStream(out),
		log:      logger,
		handlers: defaultHandlers(),
	}

	if err := s.startWatcher(); err != nil {
		logger.Printf("watcher start failed: %v (continuing without live didChange)", err)
	} else {
		logger.Printf("watcher started on %s", rootAbs)
	}

	return ReadLoop(in, s.dispatch)
}

func (s *Server) setRoot(root string) error {
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return err
	}
	st, err := os.Stat(rootAbs)
	if err != nil {
		return err
	}
	if !st.IsDir() {
		return fmt.Errorf("root is not a directory: %s", rootAbs)
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.root == rootAbs {
		return nil
	}
	s.root = rootAbs
	if s.watcher != nil {
		_ = s.watcher.Close()
		s.watcher = nil
	}
	return s.startWatcherLocked()
}

func (s *Server) startWatcher() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.startWatcherLocked()
}

func (s *Server) startWatcherLocked() error {
	if _, err := os.Stat(s.root); err != nil {
		return err
	}
	w, err := NewWatcher(s.root, func(p DidChangeParams) {
		_ = s.out.WriteJSON(Notification{
			JSONRPC: "2.0",
			Method:  MethodDidChange,
			Params:  p,
		})
	}, s.log)
	if err != nil {
		return err
	}
	s.watcher = w
	return nil
}

func (s *Server) dispatch(req Request) {
	// Notifications (no id) from client are currently unused.
	isNotification := len(req.ID) == 0 || string(req.ID) == "null"

	handler, ok := s.handlers[req.Method]
	var (
		result any
		rpcE   *RPCError
	)
	if !ok {
		rpcE = rpcErr(CodeMethodNotFound, "method not found: "+req.Method)
	} else {
		result, rpcE = unwrap(handler(s, req.Params))
	}

	if isNotification {
		return
	}

	resp := Response{JSONRPC: "2.0", ID: req.ID}
	if rpcE != nil {
		resp.Error = rpcE
	} else {
		resp.Result = result
	}
	if err := s.out.WriteJSON(resp); err != nil {
		s.log.Printf("write response: %v", err)
	}
}

func unwrap(result any, err error) (any, *RPCError) {
	if err == nil {
		return result, nil
	}
	if e, ok := err.(*RPCError); ok {
		return nil, e
	}
	return nil, rpcErr(CodeInternalError, err.Error())
}
