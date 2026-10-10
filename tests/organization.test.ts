import assert from "node:assert/strict"
import { execFile, execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"
import type { TestContext } from "node:test"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import type { CheckReport, OrganizationLock, ReviewContext } from "../src/model.js"

const cli = fileURLToPath(new URL("../dist/main.js", import.meta.url))
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, {
  cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }
}).trim()
const write = (repo: string, file: string, content: string) => {
  mkdirSync(dirname(join(repo, file)), { recursive: true })
  writeFileSync(join(repo, file), content)
}
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n"
const repoConfig = (repo: string, config: Record<string, unknown>) => write(repo, ".benedict/config.json", json(config))
const skill = (repo: string, name: string, body: string, description = `${name} guidance.`) =>
  write(repo, `.benedict/skills/${name}/SKILL.md`, `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`)
const commit = (repo: string, message: string) => { git(repo, "add", "."); git(repo, "commit", "--quiet", "-m", message); return git(repo, "rev-parse", "HEAD") }
const init = (repo: string) => {
  mkdirSync(repo, { recursive: true })
  git(repo, "init", "--quiet")
  git(repo, "config", "user.name", "Organization Test")
  git(repo, "config", "user.email", "test@example.invalid")
  git(repo, "config", "commit.gpgsign", "false")
}

const fixture = (t: TestContext) => {
  const area = mkdtempSync(join(tmpdir(), "benedict-organization-"))
  t.after(() => rmSync(area, { recursive: true, force: true }))
  const repo = join(area, "project")
  const organization = join(area, "engineering-skills")
  const home = join(area, "home")
  const cache = join(area, "cache")
  mkdirSync(home)
  init(repo)
  write(repo, "src.ts", "before();\n")
  commit(repo, "base")
  init(organization)
  skill(organization, "credentials", "Never log credentials.")
  const revision = commit(organization, "initial approved skills")
  const env = {
    ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: join(home, ".codex"),
    XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"),
    BENEDICT_CACHE_DIR: cache, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", DISABLE_TELEMETRY: "1"
  }
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd: repo, env, encoding: "utf8" })
  // Policy is read from the review's base, so review the uncommitted worktree against the committed policy.
  const context = () => {
    const result = run("context", "--worktree")
    assert.equal(result.status, 0, result.stderr)
    return JSON.parse(result.stdout) as ReviewContext
  }
  const skillBody = (name: string) => {
    const result = run("skill", name, "--base", "HEAD")
    assert.equal(result.status, 0, result.stderr)
    return result.stdout
  }
  const failure = (...args: string[]) => {
    const result = run(...args)
    assert.equal(result.status, 2, result.stdout)
    return JSON.parse(result.stderr).error.code as string
  }
  const configure = (extra: Record<string, unknown> = {}) => repoConfig(repo, { organization: { source: organization }, ...extra })
  const sync = (...args: string[]) => {
    const result = run("sync", ...args)
    assert.equal(result.status, 0, result.stderr)
    return JSON.parse(result.stdout) as { organization: OrganizationLock; skills: string[]; lockChanged: boolean }
  }
  const lockPath = join(repo, ".benedict/organization.lock.json")
  return { area, repo, organization, home, cache, revision, env, run, context, skillBody, failure, configure, sync, lockPath }
}

test("sync pins organization skills, and context lists them with the revision", (t) => {
  const { repo, configure, revision, sync, context, skillBody, run } = fixture(t)
  configure()
  const synced = sync()
  assert.equal(synced.organization.revision, revision)
  assert.deepEqual(synced.skills, ["credentials"])
  commit(repo, "connect organization")
  const result = context()
  assert.equal(result.organization?.revision, revision)
  assert.deepEqual(result.skills.map((item) => [item.name, item.scope]), [["correctness", "built-in"], ["security", "built-in"], ["credentials", "organization"]])
  assert.equal(skillBody("credentials"), "Never log credentials.\n")
  assert.match(run("context", "--worktree", "--format", "text").stdout, /- credentials \(organization\): credentials guidance\./)
})

test("the organization repository reviews itself with its skills as repository skills", (t) => {
  const { organization, env } = fixture(t)
  const result = spawnSync(process.execPath, [cli, "context", "--worktree"], { cwd: organization, env, encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual((JSON.parse(result.stdout) as ReviewContext).skills.at(-1)?.scope, "repository")
})

test("sync requires organization skills", (t) => {
  const { organization, configure, failure, lockPath } = fixture(t)
  git(organization, "mv", ".benedict/skills", "skills")
  commit(organization, "skills outside .benedict")
  configure()
  assert.equal(failure("sync"), "organization_error")
  assert.equal(existsSync(lockPath), false)
})

test("review commands require the committed lock and cache without fetching implicitly", (t) => {
  const { repo, configure, sync, cache, organization, context, revision, lockPath, failure } = fixture(t)
  configure()
  commit(repo, "config without lock")
  assert.equal(failure("context", "--worktree"), "organization_unavailable")
  assert.equal(existsSync(cache), false)
  sync()
  // The lock only applies once it is committed at the review's base.
  assert.equal(failure("context", "--worktree"), "organization_unavailable")
  commit(repo, "lock")
  const locked = readFileSync(lockPath, "utf8")
  renameSync(organization, organization + "-offline")
  assert.equal(context().organization?.revision, revision)
  assert.equal(sync().lockChanged, false)
  assert.equal(readFileSync(lockPath, "utf8"), locked)
  rmSync(cache, { recursive: true })
  assert.equal(failure("context", "--worktree"), "organization_unavailable")
  assert.equal(existsSync(cache), false)
})

test("organization changes require --update; normal sync preserves the pin", (t) => {
  const { repo, configure, sync, organization, revision, skillBody, lockPath } = fixture(t)
  configure()
  sync()
  commit(repo, "connect organization")
  const locked = readFileSync(lockPath, "utf8")
  skill(organization, "credentials", "Updated approved guidance.")
  const next = commit(organization, "update skill")
  assert.equal(sync().organization.revision, revision)
  assert.equal(readFileSync(lockPath, "utf8"), locked)
  assert.equal(skillBody("credentials"), "Never log credentials.\n")
  assert.equal(sync("--update").organization.revision, next)
  commit(repo, "update organization")
  assert.equal(skillBody("credentials"), "Updated approved guidance.\n")
})

test("a fresh machine restores the exact lock instead of the current branch", (t) => {
  const { repo, configure, sync, cache, organization, revision, skillBody } = fixture(t)
  configure()
  sync()
  commit(repo, "connect organization")
  skill(organization, "credentials", "Newer guidance.")
  commit(organization, "later")
  rmSync(cache, { recursive: true })
  const result = sync()
  assert.equal(result.organization.revision, revision)
  assert.equal(result.lockChanged, false)
  assert.equal(skillBody("credentials"), "Never log credentials.\n")
})

test("check accepts organization skills and identifies the organization revision", (t) => {
  const { area, repo, configure, sync, run, revision } = fixture(t)
  configure()
  sync()
  commit(repo, "connect organization")
  write(repo, "src.ts", "after();\n")
  const input = join(area, "findings.json")
  writeFileSync(input, JSON.stringify({ findings: [{ file: "src.ts", startLine: 1, endLine: 1,
    severity: "low", skill: "credentials", title: "Draft", explanation: "An explanation", quote: "after();", confidence: 0.3 }] }))
  const result = run("check", input, "--worktree")
  assert.equal(result.status, 0, result.stderr + result.stdout)
  const report = JSON.parse(result.stdout) as CheckReport
  assert.equal(report.organization?.revision, revision)
  assert.equal(report.accepted[0]?.skill, "credentials")
})

test("invalid organization skills fail closed, and failed updates keep the previous lock", (t) => {
  const { repo, configure, sync, organization, lockPath, context, revision, failure } = fixture(t)
  configure()
  sync()
  commit(repo, "connect organization")
  const before = readFileSync(lockPath, "utf8")
  write(organization, ".benedict/skills/broken/SKILL.md", "No frontmatter.\n")
  commit(organization, "bad skill")
  assert.equal(failure("sync", "--update"), "skill_error")
  assert.equal(readFileSync(lockPath, "utf8"), before)
  assert.equal(context().organization?.revision, revision)
})

test("repository skills override organization skills, which override built-in skills", (t) => {
  const { repo, configure, sync, organization, context, skillBody } = fixture(t)
  skill(organization, "security", "Organization security rules.", "Organization security.")
  commit(organization, "replace built-in security")
  configure()
  sync()
  commit(repo, "connect organization")
  const scopes = () => Object.fromEntries(context().skills.map((item) => [item.name, item.scope]))
  assert.deepEqual(scopes(), { correctness: "built-in", security: "organization", credentials: "organization" })
  assert.match(skillBody("security"), /Organization security rules/)
  skill(repo, "credentials", "Repository credential rules.", "Repository credentials.")
  skill(repo, "security", "Repository security rules.", "Repository security.")
  commit(repo, "replace organization skills")
  assert.deepEqual(scopes(), { correctness: "built-in", security: "repository", credentials: "repository" })
  assert.match(skillBody("credentials"), /Repository credential rules/)
  assert.match(skillBody("security"), /Repository security rules/)
})

test("organization skills cannot be symlinks", (t) => {
  const { organization, configure, failure, area, lockPath } = fixture(t)
  writeFileSync(join(area, "outside.md"), "---\nname: linked\ndescription: Outside.\n---\n")
  mkdirSync(join(organization, ".benedict/skills/linked"))
  symlinkSync(join(area, "outside.md"), join(organization, ".benedict/skills/linked/SKILL.md"))
  commit(organization, "external link")
  configure()
  assert.equal(failure("sync"), "skill_error")
  assert.equal(existsSync(lockPath), false)
})

test("source/ref mismatch, malformed locks and unsupported transports fail closed", (t) => {
  const { repo, configure, sync, run, lockPath, organization, failure } = fixture(t)
  configure()
  sync()
  repoConfig(repo, { organization: { source: organization, ref: "main" } })
  commit(repo, "changed ref")
  assert.equal(failure("context", "--worktree"), "organization_unavailable")
  assert.equal(run("sync").status, 2)
  configure()
  writeFileSync(lockPath, JSON.stringify({ version: 1, source: organization, ref: "HEAD", revision: "HEAD" }))
  commit(repo, "malformed lock")
  assert.equal(failure("context", "--worktree"), "organization_error")
  rmSync(lockPath)
  for (const source of ["ext::sh -c anything", "https://user:password@example.com/repo.git", "--upload-pack=anything"]) {
    repoConfig(repo, { organization: { source } })
    assert.equal(run("sync").status, 2)
  }
})

test("the organization cache cannot be placed in the reviewed repo, including through a symlink", (t) => {
  const { repo, area, configure, env } = fixture(t)
  configure()
  const link = join(area, "cache-link")
  symlinkSync(repo, link)
  for (const cache of [join(repo, "cache"), join(link, "cache")]) {
    const result = spawnSync(process.execPath, [cli, "sync"], { cwd: repo, encoding: "utf8", env: { ...env, BENEDICT_CACHE_DIR: cache } })
    assert.equal(result.status, 2)
    assert.equal(JSON.parse(result.stderr).error.code, "organization_error")
    assert.equal(existsSync(join(repo, "cache")), false)
  }
})

test("setup connects an organization while preserving the existing config", (t) => {
  const { repo, run, organization, revision, lockPath } = fixture(t)
  repoConfig(repo, { $schema: "https://example.invalid/config.schema.json" })
  const result = run("setup", "--organization", organization, "--skip-skills")
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(readFileSync(join(repo, ".benedict/config.json"), "utf8")), {
    $schema: "https://example.invalid/config.schema.json", organization: { source: organization, ref: "HEAD" }
  })
  assert.equal(JSON.parse(readFileSync(lockPath, "utf8")).revision, revision)
  const before = readFileSync(lockPath, "utf8")
  assert.equal(run("setup", "--skip-skills").status, 0)
  assert.equal(readFileSync(lockPath, "utf8"), before)
})

test("setup errors preserve config and require explicit non-interactive agent selection", (t) => {
  const { repo, run, lockPath } = fixture(t)
  repoConfig(repo, { $schema: "https://example.invalid/config.schema.json" })
  const before = readFileSync(join(repo, ".benedict/config.json"), "utf8")
  assert.equal(run("setup", "--organization", "https://user:secret@example.invalid/repo", "--skip-skills").status, 2)
  assert.equal(readFileSync(join(repo, ".benedict/config.json"), "utf8"), before)
  assert.equal(existsSync(lockPath), false)
  assert.equal(run("setup", "--yes").status, 2)
  assert.equal(run("setup", "--global", "--skip-skills").status, 2)
  assert.equal(run("setup", "--config", "other.json", "--skip-skills").status, 2)
})

test("setup installs the bundled skill and reference into the repository", (t) => {
  const { run, home, repo, area, env } = fixture(t)
  const result = run("setup", "--agent", "claude-code", "--yes")
  assert.equal(result.status, 0, result.stderr + result.stdout)
  const skill = join(repo, ".claude/skills/benedict")
  assert.match(readFileSync(join(skill, "SKILL.md"), "utf8"), /name: benedict/)
  assert.equal(readFileSync(join(skill, "references/cli.md"), "utf8"), readFileSync(fileURLToPath(new URL("../.agents/skills/benedict/references/cli.md", import.meta.url)), "utf8"))
  assert.equal(existsSync(join(home, ".claude/skills/benedict")), false)
  assert.equal(existsSync(join(home, ".agents/skills/benedict")), false)
  assert.equal(run("setup", "--agent", "claude-code", "--yes").status, 0)
  const outside = spawnSync(process.execPath, [cli, "setup", "--agent", "claude-code", "--yes"], { cwd: area, env, encoding: "utf8" })
  assert.equal(outside.status, 2)
  assert.match(outside.stderr, /setup_error/)
})

test("failed skill installation leaves the organization declaration and lock untouched", (t) => {
  const { repo, organization, run, lockPath } = fixture(t)
  const config = json({ $schema: "https://example.invalid/config.schema.json" })
  write(repo, ".benedict/config.json", config)
  // Block both the canonical directory and the agent's fallback copy target.
  write(repo, ".agents/skills", "blocked")
  write(repo, ".claude/skills", "blocked")
  const result = run("setup", "--organization", organization, "--agent", "claude-code", "--yes")
  assert.equal(result.status, 2)
  assert.match(result.stderr, /setup_error/)
  assert.equal(readFileSync(join(repo, ".benedict/config.json"), "utf8"), config)
  assert.equal(existsSync(lockPath), false)
})

test("concurrent syncs sharing a cache pin each repository's selected ref", async (t) => {
  const { repo, area, cache, organization, configure, sync, revision, env, lockPath } = fixture(t)
  configure()
  sync()
  git(organization, "branch", "approved", revision)
  skill(organization, "credentials", "Guidance on the other ref.")
  const next = commit(organization, "newer guidance")
  git(organization, "branch", "next", next)
  repoConfig(repo, { organization: { source: organization, ref: "approved" } })
  const other = join(area, "other-project")
  init(other)
  repoConfig(other, { organization: { source: organization, ref: "next" } })
  for (const coldCache of [false, true]) {
    if (coldCache) rmSync(cache, { recursive: true })
    await Promise.all([repo, other].map((cwd) => promisify(execFile)(process.execPath, [cli, "sync", "--update"], { cwd, env })))
    assert.equal(JSON.parse(readFileSync(lockPath, "utf8")).revision, revision)
    assert.equal(JSON.parse(readFileSync(join(other, ".benedict/organization.lock.json"), "utf8")).revision, next)
  }
})
