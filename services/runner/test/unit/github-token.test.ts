import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isPlaceholderGithubToken,
  redactGitSecrets,
  resolveGithubToken,
} from "../../src/util/github-token.js";
import { loadConfig } from "../../src/config.js";

describe("resolveGithubToken", () => {
  it("returns first real token", () => {
    assert.equal(
      resolveGithubToken(undefined, "", "local-dev-token", "ghp_real"),
      "ghp_real",
    );
  });

  it("ignores placeholders", () => {
    assert.equal(resolveGithubToken("smoke-local-token"), undefined);
    assert.equal(isPlaceholderGithubToken("local-dev-token"), true);
  });
});

describe("redactGitSecrets", () => {
  it("redacts embedded PATs and URL credentials", () => {
    const inUrl =
      "fatal: could not read Password for 'https://ghp_ABCDEFG123@github.com'";
    const outUrl = redactGitSecrets(inUrl);
    assert.match(outUrl, /https:\/\/\*\*\*@github\.com/);
    assert.doesNotMatch(outUrl, /ghp_ABCDEFG123/);

    const bare = "token ghp_ABCDEFG123 leaked";
    assert.equal(redactGitSecrets(bare), "token ghp_*** leaked");
  });
});

describe("loadConfig GITHUB_TOKEN placeholders", () => {
  it("strips placeholder GITHUB_TOKEN", () => {
    const cfg = loadConfig({
      GITHUB_TOKEN: "local-dev-token",
      GIT_USER_EMAIL: "agent@helmcode.app",
    });
    assert.equal(cfg.GITHUB_TOKEN, undefined);
  });
});
