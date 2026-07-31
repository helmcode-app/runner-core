package vfs

import "testing"

func TestRepoNameFromRemoteURL(t *testing.T) {
	cases := map[string]string{
		"https://github.com/helmcode-app/HelmCode.git": "HelmCode",
		"https://github.com/helmcode-app/HelmCode":     "HelmCode",
		"git@github.com:helmcode-app/runner-core.git":  "runner-core",
		"ssh://git@github.com/org/my-repo.git":         "my-repo",
		"https://gitlab.com/g/a/b/proj.git/":           "proj",
	}
	for in, want := range cases {
		if got := repoNameFromRemoteURL(in); got != want {
			t.Fatalf("repoNameFromRemoteURL(%q) = %q, want %q", in, got, want)
		}
	}
}
