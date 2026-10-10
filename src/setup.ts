import { createRequire } from "node:module"
import { fileURLToPath, pathToFileURL } from "node:url"
import { stripVTControlCharacters } from "node:util"
import { Effect, FileSystem, Path, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { readRepositoryConfig } from "./config.js"
import { ReviewError, configPath } from "./model.js"
import type { ConfigFile, OrganizationLock } from "./model.js"
import { readLock, resolveOrganization, reviewDirectory, writeAtomically, writeLock } from "./organization.js"
import { prepareOrganization, repositoryRoot } from "./sync.js"

export interface SetupOptions {
  readonly repo: string
  readonly organization?: string
  readonly ref?: string
  readonly agents: ReadonlyArray<string>
  readonly yes: boolean
  readonly skipSkills: boolean
}

const bundledSkill = fileURLToPath(new URL("../.agents/skills/benedict", import.meta.url))
const installer = fileURLToPath(new URL("./bin/cli.mjs", pathToFileURL(createRequire(import.meta.url).resolve("skills/package.json"))))

export const installSkill = Effect.fn("Setup.installSkill")(function*(cwd: string, options: SetupOptions) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const args = [installer, "add", bundledSkill, "--skill", "benedict",
    ...options.agents.flatMap((agent) => ["--agent", agent]),
    ...(options.yes ? ["--yes", "--json"] : [])]
  if (options.yes && options.agents.length === 0) {
    return yield* new ReviewError({ code: "setup_error", message: "For non-interactive setup, select agents with --agent <name> (repeat as needed, or use --agent '*')." })
  }
  const command = ChildProcess.make(process.execPath, args, {
    cwd, stdin: "inherit", stderr: "inherit",
    env: { DISABLE_TELEMETRY: "1" }, extendEnv: true
  })
  const result = yield* Effect.scoped(Effect.gen(function*() {
    const child = yield* spawner.spawn(command)
    const output = Stream.decodeText(child.stdout).pipe(Stream.tap((chunk) => Effect.sync(() => {
      if (!options.yes) process.stdout.write(chunk)
    })))
    const [stdout, exitCode] = yield* Effect.all([Stream.mkString(output), child.exitCode], { concurrency: 2 })
    return { stdout, exitCode: Number(exitCode) }
  })).pipe(Effect.timeout("10 minutes"))
  const installed = options.yes ? yield* Effect.try({
    try: () => {
      const entries: unknown = JSON.parse(result.stdout)
      return Array.isArray(entries) && entries.length > 0 && entries.every((entry) =>
        entry.name === "benedict" && entry.status === "installed" && Array.isArray(entry.agents) && entry.agents.length > 0)
    },
    catch: () => new ReviewError({ code: "setup_error", message: "The skill installer returned an invalid result. Organization configuration was not changed." })
  }) : !/Installation cancelled|Failed to install/.test(stripVTControlCharacters(result.stdout))
  if (result.exitCode !== 0 || !installed) return yield* new ReviewError({ code: "setup_error", message: `Skill installation failed or was cancelled (exit ${result.exitCode}). Organization configuration was not changed.` })
})

const saveDeclaration = Effect.fn("Setup.saveDeclaration")(function*(root: string, source: string | null, decoded: ConfigFile) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const target = source ?? path.join(yield* reviewDirectory(root), path.basename(configPath))
  if ((yield* fs.exists(target)) && (yield* fs.realPath(target)) !== path.resolve(target)) {
    return yield* new ReviewError({ code: "setup_error", message: "Setup cannot edit a symlinked config file." })
  }
  yield* writeAtomically(target, JSON.stringify(decoded, null, 2) + "\n")
})

export const setup = Effect.fn("Setup.run")(function*(options: SetupOptions) {
  if (options.yes && !options.skipSkills && options.agents.length === 0) {
    return yield* new ReviewError({ code: "setup_error", message: "For non-interactive setup, select agents with --agent <name> (repeat as needed, or use --agent '*')." })
  }
  if (options.ref !== undefined && options.organization === undefined) {
    return yield* new ReviewError({ code: "setup_error", message: `--ref requires --organization. Edit an existing organization ref in ${configPath} and run benedict sync --update.` })
  }
  const root = yield* repositoryRoot(options.repo).pipe(Effect.mapError(() =>
    new ReviewError({ code: "setup_error", message: "Setup installs Benedict into a Git repository. Run inside a project or pass --repo." })))
  const local = yield* readRepositoryConfig(root)
  let decoded = local.decoded
  let declaration: { source: string | null; decoded: ConfigFile } | null = null
  if (options.organization !== undefined) {
    const requested = { source: options.organization, ref: options.ref ?? local.decoded.organization?.ref ?? "HEAD" }
    const resolved = yield* resolveOrganization(root, requested)
    if (local.decoded.organization) {
      const current = yield* resolveOrganization(root, local.decoded.organization)
      if (current.source !== resolved.source || current.ref !== resolved.ref) {
        return yield* new ReviewError({ code: "setup_error", message: "This repository already selects another organization source/ref. Edit its config and run benedict sync --update for an explicit change." })
      }
    } else {
      decoded = { ...decoded, organization: requested }
      declaration = { source: local.source, decoded }
    }
  }
  const lock: OrganizationLock | null = decoded.organization ? (yield* prepareOrganization(root, decoded, false)).lock : null
  if (!options.skipSkills) yield* installSkill(root, options)
  if (declaration) yield* saveDeclaration(root, declaration.source, declaration.decoded)
  if (lock && JSON.stringify(yield* readLock(root)) !== JSON.stringify(lock)) yield* writeLock(root, lock)
  return { skillInstalled: !options.skipSkills, repository: root, organization: lock }
})
