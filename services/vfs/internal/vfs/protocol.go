package vfs

// JSON-RPC method names (wire protocol). Keep in sync with services/runner/src/vfs/protocol.ts.
const (
	MethodInitialize = "vfs/initialize"
	MethodRead       = "vfs/read"
	MethodWrite      = "vfs/write"
	MethodShutdown   = "vfs/shutdown"
	MethodDidChange  = "vfs/didChange"
)

// Entry types returned by vfs/initialize.
const (
	EntryFile = "file"
	EntryDir  = "dir"
)

// ChangeType maps fsnotify ops to VFS protocol types.
type ChangeType string

const (
	ChangeWrite  ChangeType = "write"
	ChangeCreate ChangeType = "create"
	ChangeRemove ChangeType = "remove"
	ChangeRename ChangeType = "rename"
)

// DidChangeParams is the payload for vfs/didChange notifications.
type DidChangeParams struct {
	Path string     `json:"path"`
	Type ChangeType `json:"type"`
}

// TreeEntry is a flattened workspace entry for vfs/initialize.
type TreeEntry struct {
	Path string `json:"path"`
	Size int64  `json:"size"`
	Type string `json:"type"` // "file" | "dir"
}

// InitializeResult is returned by vfs/initialize.
type InitializeResult struct {
	Root    string      `json:"root"`
	Name    string      `json:"name"`
	Entries []TreeEntry `json:"entries"`
}

// ReadResult is returned by vfs/read.
type ReadResult struct {
	Path    string `json:"path"`
	Content string `json:"content"`
	Size    int    `json:"size"`
}

// WriteResult is returned by vfs/write.
type WriteResult struct {
	Path string `json:"path"`
	Size int    `json:"size"`
}
