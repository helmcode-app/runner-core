package vfs

import (
	"fmt"
	"strings"
)

// collectGitRefs lists local branches, remote-tracking branches, and tags.
func collectGitRefs(root string) (GitRefsResult, error) {
	if !isGitRepo(root) {
		return GitRefsResult{
			IsRepo:         false,
			LocalBranches:  []GitRefEntry{},
			RemoteBranches: []GitRefEntry{},
			Tags:           []GitRefEntry{},
		}, nil
	}

	locals, err := listRefs(root, "refs/heads/")
	if err != nil {
		return GitRefsResult{}, err
	}
	remotes, err := listRefs(root, "refs/remotes/")
	if err != nil {
		return GitRefsResult{}, err
	}
	tags, err := listRefs(root, "refs/tags/")
	if err != nil {
		return GitRefsResult{}, err
	}
	// Detached HEAD on an exact tag → mark that tag current (HEAD badge in UI).
	if ResolveGitBranch(root) == "" {
		if tag := exactTagAtHEAD(root); tag != "" {
			for i := range tags {
				if tags[i].Name == tag {
					tags[i].IsCurrent = true
					break
				}
			}
		}
	}
	return GitRefsResult{
		IsRepo:         true,
		LocalBranches:  locals,
		RemoteBranches: remotes,
		Tags:           tags,
	}, nil
}

func exactTagAtHEAD(root string) string {
	out, err := gitOutput(root, "describe", "--tags", "--exact-match", "HEAD")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

func listRefs(root, prefix string) ([]GitRefEntry, error) {
	// %(HEAD) is "*" for the current branch tip among refs/heads.
	format := "%(refname:short)%00%(objectname:short)%00%(HEAD)%00%(objecttype)"
	out, err := gitOutput(
		root,
		"for-each-ref",
		"--format="+format,
		"--sort=refname",
		prefix,
	)
	if err != nil {
		return nil, fmt.Errorf("git for-each-ref %s: %w", prefix, err)
	}
	entries := []GitRefEntry{}
	for _, line := range strings.Split(string(out), "\n") {
		if line == "" {
			continue
		}
		parts := strings.Split(line, "\x00")
		if len(parts) < 3 {
			continue
		}
		name := parts[0]
		tip := parts[1]
		isCurrent := parts[2] == "*"
		if name == "" {
			continue
		}
		// For annotated tags, resolve peeled commit when available.
		if prefix == "refs/tags/" {
			if peeled := peelTagTip(root, name); peeled != "" {
				tip = peeled
			}
		}
		entries = append(entries, GitRefEntry{
			Name:      name,
			Tip:       tip,
			IsCurrent: isCurrent,
		})
	}
	return entries, nil
}

func peelTagTip(root, tag string) string {
	out, err := gitOutput(root, "rev-parse", "--short", tag+"^{commit}")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}
