package vfs

// JSON-RPC method names (wire protocol). Keep in sync with services/runner/src/vfs/protocol.ts.
// Git methods live in git_protocol.go.
const (
	MethodInitialize = "vfs/initialize"
	MethodRead       = "vfs/read"
	MethodReadChunk  = "vfs/read_chunk"
	MethodWrite      = "vfs/write"
	MethodShutdown   = "vfs/shutdown"
	MethodDidChange  = "vfs/didChange"
)

// Chunk size bounds for vfs/read_chunk (bytes).
const (
	DefaultChunkLimit = 64 * 1024
	MaxChunkLimit     = 256 * 1024
	// MaxFullReadBytes caps legacy vfs/read; larger files must use read_chunk.
	MaxFullReadBytes = 256 * 1024
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
	Root string `json:"root"`
	// Name is the client project label (env / git repo name / basename).
	Name string `json:"name"`
	// Remote is the git origin in display form (e.g. github.com/org/repo).
	// Empty when origin is unavailable — do not substitute container path.
	Remote string `json:"remote,omitempty"`
	// Branch is the current HEAD branch (git symbolic-ref / rev-parse).
	// Empty when detached HEAD or not a git repo — clients must not invent "main".
	Branch  string      `json:"branch,omitempty"`
	Entries []TreeEntry `json:"entries"`
}

// ReadResult is returned by vfs/read (small files only).
type ReadResult struct {
	Path    string `json:"path"`
	Content string `json:"content"`
	Size    int    `json:"size"`
}

// ReadChunkResult is returned by vfs/read_chunk.
type ReadChunkResult struct {
	Path      string `json:"path"`
	Content   string `json:"content"`
	Offset    int64  `json:"offset"`
	BytesRead int    `json:"bytes_read"`
	IsEOF     bool   `json:"is_eof"`
	// FileSize is the total size at open time (may change under concurrent writers).
	FileSize int64 `json:"file_size"`
}

// WriteResult is returned by vfs/write.
type WriteResult struct {
	Path string `json:"path"`
	Size int    `json:"size"`
}
