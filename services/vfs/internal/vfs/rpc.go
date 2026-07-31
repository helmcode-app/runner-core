package vfs

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"sync"
)

// JSON-RPC 2.0 wire types (newline-delimited).

type Request struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type Response struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *RPCError       `json:"error,omitempty"`
}

type Notification struct {
	JSONRPC string `json:"jsonrpc"`
	Method  string `json:"method"`
	Params  any    `json:"params,omitempty"`
}

type RPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    any    `json:"data,omitempty"`
}

func (e *RPCError) Error() string {
	if e == nil {
		return ""
	}
	return e.Message
}

func rpcErr(code int, msg string) *RPCError {
	return &RPCError{Code: code, Message: msg}
}

const (
	CodeParseError     = -32700
	CodeInvalidRequest = -32600
	CodeMethodNotFound = -32601
	CodeInvalidParams  = -32602
	CodeInternalError  = -32603
)

// Stream writes newline-delimited JSON to w with a mutex.
type Stream struct {
	w  io.Writer
	mu sync.Mutex
}

func NewStream(w io.Writer) *Stream {
	return &Stream{w: w}
}

func (s *Stream) WriteJSON(v any) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(s.w, "%s\n", b)
	return err
}

// ReadLoop reads NDJSON requests from r and invokes handle for each.
func ReadLoop(r io.Reader, handle func(Request)) error {
	sc := bufio.NewScanner(r)
	// Allow large file payloads in write requests (up to 16 MiB per line).
	buf := make([]byte, 0, 64*1024)
	sc.Buffer(buf, 16*1024*1024)

	for sc.Scan() {
		line := sc.Bytes()
		if len(line) == 0 {
			continue
		}
		var req Request
		if err := json.Unmarshal(line, &req); err != nil {
			// Cannot correlate id; skip or emit parse error without id.
			continue
		}
		if req.JSONRPC != "" && req.JSONRPC != "2.0" {
			continue
		}
		if req.Method == "" {
			continue
		}
		handle(req)
	}
	return sc.Err()
}
