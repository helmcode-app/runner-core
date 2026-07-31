package vfs

// isIgnoredName reports path segments that must not appear in tree walks or watches.
func isIgnoredName(name string) bool {
	switch name {
	case ".git", "node_modules", ".DS_Store":
		return true
	default:
		return false
	}
}

// pathHasIgnoredSegment reports whether any path segment is ignored.
func pathHasIgnoredSegment(relSlash string) bool {
	if relSlash == "" || relSlash == "." {
		return false
	}
	start := 0
	for i := 0; i < len(relSlash); i++ {
		if relSlash[i] == '/' {
			if i > start && isIgnoredName(relSlash[start:i]) {
				return true
			}
			start = i + 1
		}
	}
	if start < len(relSlash) && isIgnoredName(relSlash[start:]) {
		return true
	}
	return false
}
