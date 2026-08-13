package vfs

// Git JSON-RPC method names. Keep in sync with services/runner/src/vfs/protocol-git.ts.
const (
	MethodGitStatus   = "vfs/gitStatus"
	MethodGitRefs     = "vfs/gitRefs"
	MethodGitDiff     = "vfs/gitDiff"
	MethodGitShow     = "vfs/gitShow"
	MethodGitCheckout = "vfs/gitCheckout"
)

// Git ref kinds for vfs/gitCheckout.
const (
	GitRefLocalBranch  = "localBranch"
	GitRefRemoteBranch = "remoteBranch"
	GitRefTag          = "tag"
)

// Payload size caps for git RPCs (bytes).
const (
	MaxGitDiffBytes = 256 * 1024
	MaxGitShowBytes = 256 * 1024
)

// Git change status values for vfs/gitStatus.
const (
	GitStatusAdded     = "added"
	GitStatusModified  = "modified"
	GitStatusDeleted   = "deleted"
	GitStatusUntracked = "untracked"
	GitStatusRenamed   = "renamed"
)

// GitChangeEntry is one path in vfs/gitStatus (no diff body).
type GitChangeEntry struct {
	Path string `json:"path"`
	// Status: added | modified | deleted | untracked | renamed
	Status string `json:"status"`
	// Staged is true when the index side has a change for this path.
	Staged bool `json:"staged"`
	// FromPath is set for renames (previous path).
	FromPath string `json:"fromPath,omitempty"`
}

// GitStatusResult is returned by vfs/gitStatus.
type GitStatusResult struct {
	IsRepo   bool             `json:"isRepo"`
	Branch   string           `json:"branch,omitempty"`
	Upstream string           `json:"upstream,omitempty"`
	Ahead    *int             `json:"ahead,omitempty"`
	Behind   *int             `json:"behind,omitempty"`
	Changes  []GitChangeEntry `json:"changes"`
}

// GitRefEntry is one branch or tag in vfs/gitRefs.
type GitRefEntry struct {
	Name      string `json:"name"`
	Tip       string `json:"tip,omitempty"`
	IsCurrent bool   `json:"isCurrent,omitempty"`
}

// GitRefsResult is returned by vfs/gitRefs.
type GitRefsResult struct {
	IsRepo         bool          `json:"isRepo"`
	LocalBranches  []GitRefEntry `json:"localBranches"`
	RemoteBranches []GitRefEntry `json:"remoteBranches"`
	Tags           []GitRefEntry `json:"tags"`
}

// GitDiffResult is returned by vfs/gitDiff (unified diff text, no binary blobs).
type GitDiffResult struct {
	Path   string `json:"path"`
	Staged bool   `json:"staged"`
	// Diff is unified diff text (may be empty when clean / binary / unavailable).
	Diff string `json:"diff"`
	// Truncated is true when Diff was cut at MaxGitDiffBytes.
	Truncated bool `json:"truncated,omitempty"`
}

// GitShowResult is returned by vfs/gitShow (file bytes at a revision).
type GitShowResult struct {
	Path     string `json:"path"`
	Revision string `json:"revision"`
	// Exists is false when the path is missing at that revision (e.g. new file).
	Exists bool `json:"exists"`
	// Content is omitted / empty when Exists is false or the blob was binary.
	Content   string `json:"content,omitempty"`
	Truncated bool   `json:"truncated,omitempty"`
	Binary    bool   `json:"binary,omitempty"`
}

// GitCheckoutResult is returned by vfs/gitCheckout.
type GitCheckoutResult struct {
	// Ref is the requested checkout target.
	Ref string `json:"ref"`
	// Kind echoes the request kind.
	Kind string `json:"kind"`
	// Branch is the current branch after checkout (empty when detached).
	Branch string `json:"branch,omitempty"`
	// Detached is true when HEAD points at a commit/tag (not a branch).
	Detached bool `json:"detached,omitempty"`
}
