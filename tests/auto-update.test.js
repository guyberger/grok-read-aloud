import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * `tools/auto-update.sh`, against real checkouts with a real remote.
 *
 * The remote is a bare repository in a temp directory, so every `git fetch`
 * here is a local file copy and nothing needs the network. The point of each
 * case is the same: a run that cannot fast-forward safely must leave the
 * working tree exactly as it found it. These tests assert what the script did
 * *not* do — the commit is still HEAD, the uncommitted file is still
 * uncommitted, the untracked file is still there — because a reset, a stash or
 * a clean would be the kind of mistake nobody notices until their work is gone.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = resolve(ROOT, "tools/auto-update.sh");

const hasGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const git = (cwd, ...args) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const head = (cwd) => git(cwd, "rev-parse", "HEAD");

/**
 * A bare remote, a clone of it on main, and a second clone used as the place
 * other people's commits are pushed from.
 *
 * The clone gets a `tools/build.js` of its own that writes a marker file, so a
 * test can tell "it pulled" from "it pulled and rebuilt" — which is the whole
 * reason the script runs a build at all.
 */
function makeCheckout() {
  const base = mkdtempSync(resolve(tmpdir(), "auto-update-"));
  const remote = resolve(base, "remote.git");
  const local = resolve(base, "local");
  const other = resolve(base, "other");

  git(base, "init", "--bare", "--initial-branch=main", remote);

  git(base, "clone", "--quiet", remote, local);
  mkdirSync(resolve(local, "tools"), { recursive: true });
  writeFileSync(resolve(local, "README.md"), "one\n");
  writeFileSync(
    resolve(local, "tools/build.js"),
    [
      "// Stands in for the real build: records that it ran, with its arguments.",
      'import { appendFileSync } from "node:fs";',
      'appendFileSync(new URL("../built.log", import.meta.url), `${process.argv.slice(2).join(" ")}\\n`);',
      "",
    ].join("\n"),
  );
  writeFileSync(resolve(local, "package.json"), `{ "type": "module" }\n`);
  git(local, "add", "-A");
  git(local, "commit", "--quiet", "-m", "first");
  git(local, "push", "--quiet", "-u", "origin", "main");

  git(base, "clone", "--quiet", remote, other);
  return { base, remote, local, other };
}

/** A commit someone else pushed, the way a merge to main arrives. */
function pushUpstream({ other }, text = "two\n") {
  writeFileSync(resolve(other, "README.md"), text);
  git(other, "add", "-A");
  git(other, "commit", "--quiet", "-m", "upstream");
  git(other, "push", "--quiet", "origin", "main");
  return head(other);
}

function run(repo, ...args) {
  const result = spawnSync("bash", [SCRIPT, "--repo", repo, ...args], {
    encoding: "utf8",
    env: { ...process.env, NODE_BIN: process.execPath },
  });
  const stdout = result.stdout ?? "";
  return {
    outcome: (stdout.match(/^status=(\S+)$/m) ?? [])[1] ?? "",
    exitCode: result.outcome,
    stdout,
    output: `${stdout}${result.stderr ?? ""}`,
  };
}

const built = (checkout) => existsSync(resolve(checkout.local, "built.log"));

test("tools/auto-update.sh", { skip: hasGit ? false : "no git" }, async (t) => {
  const made = [];
  const checkout = () => {
    const fresh = makeCheckout();
    made.push(fresh);
    return fresh;
  };
  t.after(() => {
    for (const { base } of made) rmSync(base, { recursive: true, force: true });
  });

  await t.test("with nothing new on origin/main it does nothing", () => {
    const where = checkout();
    const before = head(where.local);
    const result = run(where.local);
    assert.equal(result.outcome, "up-to-date");
    assert.equal(head(where.local), before);
    assert.equal(built(where), false, "nothing to rebuild for");
  });

  await t.test("a commit on origin/main is fast-forwarded and rebuilt", () => {
    const where = checkout();
    const upstream = pushUpstream(where);
    const result = run(where.local);
    assert.equal(result.outcome, "updated", result.output);
    assert.equal(head(where.local), upstream);
    assert.equal(built(where), true, "the dev build ran");
    assert.match(
      execFileSync("cat", [resolve(where.local, "built.log")], { encoding: "utf8" }),
      /--dev --only chrome/,
      "and it was the dev build, not the production one",
    );
  });

  await t.test("an uncommitted change stops it, and survives it", () => {
    const where = checkout();
    const upstream = pushUpstream(where);
    const before = head(where.local);
    writeFileSync(resolve(where.local, "README.md"), "work in progress\n");

    const result = run(where.local);
    assert.equal(result.outcome, "skipped-dirty", result.output);
    assert.equal(head(where.local), before, "it did not move off the commit being worked on");
    assert.notEqual(head(where.local), upstream);
    assert.equal(
      execFileSync("cat", [resolve(where.local, "README.md")], { encoding: "utf8" }),
      "work in progress\n",
      "the uncommitted change is still there",
    );
    assert.match(result.stdout, /local changes/);
    assert.equal(built(where), false, "and nothing was rebuilt over it");
  });

  await t.test("an untracked file stops it too, and is not cleaned away", () => {
    const where = checkout();
    pushUpstream(where);
    const before = head(where.local);
    writeFileSync(resolve(where.local, "scratch.md"), "notes\n");

    const result = run(where.local);
    assert.equal(result.outcome, "skipped-dirty", result.output);
    assert.equal(head(where.local), before);
    assert.equal(existsSync(resolve(where.local, "scratch.md")), true, "the untracked file is still there");
  });

  await t.test("a branch that is not main is left alone", () => {
    const where = checkout();
    pushUpstream(where);
    git(where.local, "checkout", "--quiet", "-b", "a-feature");
    const before = head(where.local);

    const result = run(where.local);
    assert.equal(result.outcome, "skipped-branch", result.output);
    assert.equal(head(where.local), before);
    assert.equal(git(where.local, "rev-parse", "--abbrev-ref", "HEAD"), "a-feature");
    assert.match(result.stdout, /not main/);
  });

  await t.test("a branch that is not main is left alone even with nothing to pull", () => {
    const where = checkout();
    git(where.local, "checkout", "--quiet", "-b", "a-feature");
    assert.equal(run(where.local).outcome, "skipped-branch");
  });

  await t.test("a local commit of its own is never merged over", () => {
    const where = checkout();
    pushUpstream(where);
    writeFileSync(resolve(where.local, "mine.md"), "mine\n");
    git(where.local, "add", "-A");
    git(where.local, "commit", "--quiet", "-m", "mine");
    const before = head(where.local);

    const result = run(where.local);
    assert.equal(result.outcome, "skipped-diverged", result.output);
    assert.equal(head(where.local), before, "the local commit is still HEAD");
    assert.equal(git(where.local, "log", "-1", "--pretty=%s"), "mine");
    assert.equal(built(where), false);
  });

  await t.test("a commit of its own that origin/main already has is a fast-forward", () => {
    // Pushed from this checkout, then reached from another: HEAD is an
    // ancestor of origin/main, so there is nothing to merge, only to catch up.
    const where = checkout();
    writeFileSync(resolve(where.local, "mine.md"), "mine\n");
    git(where.local, "add", "-A");
    git(where.local, "commit", "--quiet", "-m", "mine");
    git(where.local, "push", "--quiet", "origin", "main");
    git(where.other, "fetch", "--quiet", "origin");
    git(where.other, "reset", "--hard", "--quiet", "origin/main");
    const upstream = pushUpstream(where, "three\n");

    assert.equal(run(where.local).outcome, "updated");
    assert.equal(head(where.local), upstream);
  });

  await t.test("--no-build pulls without building", () => {
    const where = checkout();
    const upstream = pushUpstream(where);
    assert.equal(run(where.local, "--no-build").outcome, "updated");
    assert.equal(head(where.local), upstream);
    assert.equal(built(where), false);
  });

  await t.test("a directory that is not a checkout is an error, not a silent skip", () => {
    const where = checkout();
    const result = run(resolve(where.base, "nowhere"));
    assert.equal(result.outcome, "failed-repo");
    assert.notEqual(result.exitCode, 0, "and it exits non-zero so launchd records it");
  });

  await t.test("every run ends by saying what it did", () => {
    const where = checkout();
    assert.match(run(where.local).stdout, /\nstatus=[a-z-]+\n?$/);
  });
});

/**
 * The LaunchAgent the installer writes. Loading it needs macOS, so this only
 * checks the plist it hands launchctl — which is where the two things that
 * actually go wrong live: a relative path, and a PATH with no node on it.
 */
test("tools/auto-update-install.sh writes a LaunchAgent for this checkout", () => {
  const home = mkdtempSync(resolve(tmpdir(), "auto-update-home-"));
  try {
    const result = spawnSync("bash", [resolve(ROOT, "tools/auto-update-install.sh"), "--no-load"], {
      encoding: "utf8",
      env: { ...process.env, HOME: home, NODE_BIN: process.execPath },
    });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);

    const plist = resolve(
      home,
      "Library/LaunchAgents/com.github.guyberger.grok-read-aloud.auto-update.plist",
    );
    assert.equal(existsSync(plist), true, result.stdout);
    const written = readFileSync(plist, "utf8");

    assert.match(written, /<key>StartInterval<\/key>\s*<integer>3600<\/integer>/, "hourly, not by the minute");
    assert.match(written, /<key>RunAtLoad<\/key>\s*<true\/>/);
    assert.match(
      written,
      new RegExp(`<string>${resolve(ROOT, "tools/auto-update.sh")}</string>`),
      "an absolute path to this checkout's script",
    );
    assert.match(written, /grok-read-aloud-auto-update\.log/);
    // The whole point of resolving node at install time: launchd's PATH has
    // neither Homebrew's bin nor an nvm one on it.
    assert.match(written, new RegExp(`<string>${dirname(process.execPath)}:`), "node's directory is on PATH");
    assert.match(written, new RegExp(`<key>NODE_BIN</key>\\s*<string>${process.execPath}</string>`));

    // Valid XML, which is the other half of "launchctl will take it".
    const plutil = spawnSync("plutil", ["-lint", plist], { encoding: "utf8" });
    if (plutil.status !== null && !plutil.error) {
      assert.equal(plutil.status, 0, plutil.stdout + plutil.stderr);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
