import { describe, expect, test } from "bun:test";
import { webCommitUrl, webSourceUrl } from "./webLinks.ts";

describe("webSourceUrl", () => {
  test("GitLab citation linked", () => {
    expect(
      webSourceUrl("git@gitlab.corp:team/repo.git", "abc1234", "src/auth.ts", {
        start: 10,
        end: 20,
      }),
    ).toBe("https://gitlab.corp/team/repo/-/blob/abc1234/src/auth.ts#L10-20");
  });

  test("GitHub citation linked", () => {
    expect(
      webSourceUrl("git@github.com:team/repo.git", "abc1234", "src/auth.ts", {
        start: 10,
        end: 20,
      }),
    ).toBe("https://github.com/team/repo/blob/abc1234/src/auth.ts#L10-L20");
  });

  test("File citation without a line range", () => {
    expect(webSourceUrl("git@gitlab.corp:team/repo.git", "abc1234", "README.md", null)).toBe(
      "https://gitlab.corp/team/repo/-/blob/abc1234/README.md",
    );
  });

  test("Single-line citation", () => {
    expect(
      webSourceUrl("git@gitlab.corp:team/repo.git", "abc1234", "src/auth.ts", {
        start: 8,
        end: 8,
      }),
    ).toBe("https://gitlab.corp/team/repo/-/blob/abc1234/src/auth.ts#L8");
  });

  test("ssh-with-port and https sources link like scp-like ones", () => {
    expect(webSourceUrl("ssh://git@gitlab.corp:2222/team/repo.git", "abc", "a.ts", null)).toBe(
      "https://gitlab.corp/team/repo/-/blob/abc/a.ts",
    );
    expect(webSourceUrl("https://github.corp/team/repo.git", "abc", "a.ts", null)).toBe(
      "https://github.corp/team/repo/blob/abc/a.ts",
    );
  });

  test("path case is preserved and segments are percent-encoded", () => {
    expect(webSourceUrl("git@gitlab.corp:team/Repo.git", "abc", "Src/My File.ts", null)).toBe(
      "https://gitlab.corp/team/Repo/-/blob/abc/Src/My%20File.ts",
    );
    expect(webSourceUrl("git@gitlab.corp:team/my repo.git", "abc", "a.ts", null)).toBe(
      "https://gitlab.corp/team/my%20repo/-/blob/abc/a.ts",
    );
  });

  test("Unlinkable repository degrades to null", () => {
    expect(webSourceUrl("/srv/code/repo", "abc", "a.ts", null)).toBeNull();
    expect(webSourceUrl("git@code.corp:team/repo.git", "abc", "a.ts", null)).toBeNull();
    expect(webSourceUrl("git@gitlab.corp:team/repo.git", null, "a.ts", null)).toBeNull();
    expect(webSourceUrl("git@gitlab.corp:team/repo.git", "", "a.ts", null)).toBeNull();
  });
});

describe("webCommitUrl", () => {
  test("GitHub commit linked", () => {
    expect(webCommitUrl("git@github.com:team/repo.git", "abc1234")).toBe(
      "https://github.com/team/repo/commit/abc1234",
    );
  });

  test("GitLab commit linked", () => {
    expect(webCommitUrl("git@gitlab.corp:team/repo.git", "abc1234")).toBe(
      "https://gitlab.corp/team/repo/-/commit/abc1234",
    );
  });

  test("path segments are percent-encoded", () => {
    expect(webCommitUrl("git@gitlab.corp:team/my repo.git", "abc")).toBe(
      "https://gitlab.corp/team/my%20repo/-/commit/abc",
    );
  });

  test("Unlinkable repository degrades to null", () => {
    expect(webCommitUrl("/srv/code/repo", "abc")).toBeNull();
    expect(webCommitUrl("git@code.corp:team/repo.git", "abc")).toBeNull();
    expect(webCommitUrl("git@gitlab.corp:team/repo.git", null)).toBeNull();
    expect(webCommitUrl("git@gitlab.corp:team/repo.git", "")).toBeNull();
  });
});
