package vfs

import (
	"fmt"
	"strconv"
	"strings"
)

// collectGitStatus runs `git status --porcelain=v2 -b` and maps it to GitStatusResult.
func collectGitStatus(root string) (GitStatusResult, error) {
	if !isGitRepo(root) {
		return GitStatusResult{IsRepo: false, Changes: []GitChangeEntry{}}, nil
	}

	out, err := gitOutput(
		root,
		"status", "--porcelain=v2", "-b", "--untracked-files=normal",
	)
	if err != nil {
		return GitStatusResult{}, fmt.Errorf("git status: %w", err)
	}
	return parseGitStatusPorcelainV2(out), nil
}

func parseGitStatusPorcelainV2(out []byte) GitStatusResult {
	res := GitStatusResult{
		IsRepo:  true,
		Changes: []GitChangeEntry{},
	}
	for _, line := range strings.Split(string(out), "\n") {
		if line == "" {
			continue
		}
		switch {
		case strings.HasPrefix(line, "# branch.head "):
			head := strings.TrimPrefix(line, "# branch.head ")
			if head != "(detached)" {
				res.Branch = head
			}
		case strings.HasPrefix(line, "# branch.upstream "):
			res.Upstream = strings.TrimPrefix(line, "# branch.upstream ")
		case strings.HasPrefix(line, "# branch.ab "):
			ahead, behind, ok := parseBranchAB(strings.TrimPrefix(line, "# branch.ab "))
			if ok {
				res.Ahead = &ahead
				res.Behind = &behind
			}
		case strings.HasPrefix(line, "1 "):
			if ch, ok := parseOrdinaryChanged(line); ok {
				res.Changes = append(res.Changes, ch)
			}
		case strings.HasPrefix(line, "2 "):
			if ch, ok := parseRenamedChanged(line); ok {
				res.Changes = append(res.Changes, ch)
			}
		case strings.HasPrefix(line, "u "):
			if ch, ok := parseUnmergedChanged(line); ok {
				res.Changes = append(res.Changes, ch)
			}
		case strings.HasPrefix(line, "? "):
			path := strings.TrimPrefix(line, "? ")
			if path != "" {
				res.Changes = append(res.Changes, GitChangeEntry{
					Path:   path,
					Status: GitStatusUntracked,
					Staged: false,
				})
			}
		}
	}
	return res
}

func parseBranchAB(raw string) (ahead, behind int, ok bool) {
	// Format: +<ahead> -<behind>
	fields := strings.Fields(raw)
	if len(fields) < 2 {
		return 0, 0, false
	}
	a, errA := strconv.Atoi(strings.TrimPrefix(fields[0], "+"))
	b, errB := strconv.Atoi(strings.TrimPrefix(fields[1], "-"))
	if errA != nil || errB != nil {
		return 0, 0, false
	}
	return a, b, true
}

// Ordinary changed: 1 XY sub mH mI mW hH hI path
func parseOrdinaryChanged(line string) (GitChangeEntry, bool) {
	rest := strings.TrimPrefix(line, "1 ")
	fields := strings.Fields(rest)
	if len(fields) < 8 {
		return GitChangeEntry{}, false
	}
	xy := fields[0]
	if len(xy) < 2 {
		return GitChangeEntry{}, false
	}
	x, y := xy[0], xy[1]
	path := strings.Join(fields[7:], " ")
	if path == "" {
		return GitChangeEntry{}, false
	}
	return GitChangeEntry{
		Path:   path,
		Status: mapXYStatus(x, y),
		Staged: x != '.',
	}, true
}

// Rename/copy: 2 XY sub mH mI mW hH hI XY score\tpath\torig
func parseRenamedChanged(line string) (GitChangeEntry, bool) {
	rest := strings.TrimPrefix(line, "2 ")
	tab := strings.Split(rest, "\t")
	if len(tab) < 3 {
		return GitChangeEntry{}, false
	}
	meta := strings.Fields(tab[0])
	if len(meta) < 1 {
		return GitChangeEntry{}, false
	}
	xy := meta[0]
	if len(xy) < 2 {
		return GitChangeEntry{}, false
	}
	x := xy[0]
	path := tab[1]
	from := tab[2]
	if path == "" {
		return GitChangeEntry{}, false
	}
	return GitChangeEntry{
		Path:     path,
		FromPath: from,
		Status:   GitStatusRenamed,
		Staged:   x != '.',
	}, true
}

func parseUnmergedChanged(line string) (GitChangeEntry, bool) {
	rest := strings.TrimPrefix(line, "u ")
	fields := strings.Fields(rest)
	if len(fields) < 10 {
		return GitChangeEntry{}, false
	}
	path := strings.Join(fields[9:], " ")
	if path == "" {
		return GitChangeEntry{}, false
	}
	return GitChangeEntry{
		Path:   path,
		Status: GitStatusModified,
		Staged: false,
	}, true
}

func mapXYStatus(x, y byte) string {
	for _, c := range []byte{y, x} {
		switch c {
		case 'A':
			return GitStatusAdded
		case 'D':
			return GitStatusDeleted
		case 'R', 'C':
			return GitStatusRenamed
		case 'M', 'T', 'U':
			return GitStatusModified
		}
	}
	return GitStatusModified
}
