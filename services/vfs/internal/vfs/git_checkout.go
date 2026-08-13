package vfs

import (
	"fmt"
	"strings"
)

// collectGitCheckout switches HEAD to a local branch, remote-tracking branch, or tag.
func collectGitCheckout(root, ref, kind string) (GitCheckoutResult, error) {
	ref = strings.TrimSpace(ref)
	kind = strings.TrimSpace(kind)
	res := GitCheckoutResult{Ref: ref, Kind: kind}
	if !isGitRepo(root) {
		return res, fmt.Errorf("not a git repository")
	}
	if err := validateGitRefName(ref); err != nil {
		return res, err
	}

	var args []string
	switch kind {
	case GitRefLocalBranch:
		args = []string{"switch", "--", ref}
	case GitRefRemoteBranch:
		localName, err := localNameFromRemoteRef(ref)
		if err != nil {
			return res, err
		}
		if localBranchExists(root, localName) {
			args = []string{"switch", "--", localName}
		} else {
			// Create local branch tracking the remote-tracking ref.
			args = []string{"switch", "-c", localName, "--track", ref}
		}
	case GitRefTag:
		args = []string{"switch", "--detach", "--", ref}
	default:
		return res, fmt.Errorf("unsupported ref kind %q", kind)
	}

	out, err := gitCombined(root, args...)
	if err != nil {
		msg := strings.TrimSpace(string(out))
		if msg == "" {
			msg = err.Error()
		}
		return res, fmt.Errorf("%s", msg)
	}

	branch := ResolveGitBranch(root)
	res.Branch = branch
	res.Detached = branch == ""
	return res, nil
}

// localNameFromRemoteRef maps origin/foo/bar → foo/bar.
func localNameFromRemoteRef(ref string) (string, error) {
	i := strings.IndexByte(ref, '/')
	if i <= 0 || i+1 >= len(ref) {
		return "", fmt.Errorf("invalid remote branch %q", ref)
	}
	return ref[i+1:], nil
}

func localBranchExists(root, name string) bool {
	_, err := gitOutput(root, "show-ref", "--verify", "--quiet", "refs/heads/"+name)
	return err == nil
}
