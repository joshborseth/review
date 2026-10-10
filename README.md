# Benedict

Benedict is a code review skill for coding agents, plus a CLI that keeps the agent honest. Your agent does the review locally, guided by review skills. The CLI throws out any finding it can't back up with a quote from the source. The Benedict GitHub App then posts the review and approves the PR when the agent judges it safe.

Benedict is a cat who reviews code.

## Install

Requires Node.js 22.20+ and Git.

```sh
npm install --global https://github.com/josh-borseth-fp-ai/benedict/releases/latest/download/benedict.tgz
cd your-repo
benedict setup
```

`benedict setup` installs the skill into the repository, under `.agents/skills/benedict/` and each selected agent's skill folder, such as `.claude/skills/benedict/`. Commit those files so everyone who clones the repository gets the skill. Nothing is installed in your home directory. Rerun both commands to upgrade, then commit the updated skill. pnpm and Bun work too: `pnpm add --global <url>` or `bun add --global <url>`.

## Use it

Ask your agent to review a change with the `benedict` skill, for example "use benedict to review this PR". The skill lives at [`.agents/skills/benedict/SKILL.md`](.agents/skills/benedict/SKILL.md).

The agent then:

1. Runs `benedict context` to get the diff and the review skills that apply to each file.
2. Reads the relevant skills with `benedict skill`, reviews the code, and writes draft findings as JSON.
3. Runs `benedict check`, which drops findings that are outside the diff, don't quote the source, use a skill that doesn't apply to the file, or are duplicates.
4. For a PR, decides whether it is safe to approve and runs `benedict publish` to post the review.

Every finding has a severity and a confidence, and every review includes an overall **Confidence: N/5**. PR reviews also include a Mermaid diagram of what changed, and PRs that change the UI get screenshots and a short video.

## Commands

```sh
benedict context                         # review HEAD~1..HEAD
benedict context --base main --head HEAD # a different range
benedict context --worktree              # uncommitted changes
benedict context --pr <PR URL>           # a GitHub PR
benedict skill <name> --base <commit>    # print a review skill

benedict check findings.json             # validate draft findings
benedict publish findings.json --pr <PR URL> --confidence 4 --decision approve|comment [--dry-run]

benedict setup                           # install the skill into this repository
benedict sync                            # fetch organization skills
```

Run `benedict <command> --help` for flags. The finding format is in [`references/cli.md`](.agents/skills/benedict/references/cli.md).

`check` exits 0 when every finding passes, 1 when some were rejected, and 2 on an error.

## Publishing to GitHub

Sign in to the [GitHub CLI](https://cli.github.com/) with `gh auth login` and to the [Infisical CLI](https://infisical.com/docs/cli/overview) with `infisical login`. There is nothing else to set: when `publish` posts, it reads the GitHub App's credentials from ForwardPath's Benedict Infisical project, whose ID is built into the CLI.

`publish` posts one GitHub review from `benedict[bot]`, with an inline comment for each finding. Use `--dry-run` to preview the review without posting it; it doesn't need Infisical. Rerunning the same command is safe.

## Approving PRs

Every PR review ends with the agent's own decision on whether the PR is safe to approve, passed as `--decision approve` or `--decision comment`. Findings and the confidence score inform that decision but don't decide it. With `approve`, the bot submits the review as an approval of the exact reviewed commit. There is nothing to configure: installing the GitHub App on a repository turns approval on.

The CLI only checks that the approval covers what was reviewed: the PR head must be the reviewed commit, the review must start at the PR's merge base, and the bot won't re-approve a commit after a person dismissed its approval. When it refuses, it still posts the review as a comment and `publish` exits 1.

To require a review on every PR, add this to a repository's `AGENTS.md`:

```md
## Benedict

After opening a PR or pushing to one, use the `benedict` skill to review the whole
current PR and publish the review with your approval decision. Fix accepted
findings and repeat. If Benedict doesn't approve, report why and request human
review; do not approve the PR another way.
```

Approval is the model's judgment, so content in a PR can try to talk it into approving. Keep branch protection and required human reviewers where that matters. Anyone with access to the Benedict Infisical project holds the app's private key, so they can approve PRs, including their own, by calling GitHub directly. Remove people from the project when they leave, rotate the key if it may have been copied, and enable dismissal of stale approvals on protected branches.

## Setting up the GitHub App

Create an organization-owned GitHub App:

- Permissions: **Pull requests: read and write**, **Contents: read**, **Metadata: read**.
- Webhook: off.
- Installation: this organization only.

Install it on the repositories it should review. Generate a private key, then add two secrets to the Benedict Infisical project's `prod` environment:

| Secret | Value |
| --- | --- |
| `BENEDICT_APP_ID` | The numeric app ID |
| `BENEDICT_APP_PRIVATE_KEY` | The full PEM private key |

Branch rules decide whether the bot's approval counts; confirm on a scratch repository before relying on it. A GitHub App can't be a code owner, so code-owner reviews still need a person.

## Review skills

Review skills tell the agent what to look for. Benedict ships `correctness` and `security`. Add your own as `.benedict/skills/<name>/SKILL.md` in the reviewed repository, in the usual skill format:

```md
---
name: payments
description: Money handling, idempotency and currency rounding.
paths: ["billing/**"]
---

Report double charges, lost refunds and rounding that changes totals.
```

`paths` is optional; without it the skill applies to every file. A repository skill with the same name as an organization or built-in skill replaces it. Skills are read from the review's base commit, so a PR can't change the skills it's reviewed under. See [`references/skills.md`](.agents/skills/benedict/references/skills.md).

## Organization skills

Teams can share skills from a separate Git repository that keeps them in `.benedict/skills/`. Connect a project with:

```sh
benedict setup --organization https://github.com/your-org/engineering-skills.git
```

This writes `.benedict/config.json`, which holds only the organization source, and pins a revision in `.benedict/organization.lock.json`. Commit both. `benedict sync` restores the pinned revision on a new machine, and `benedict sync --update` moves it forward.

## Develop

```sh
npm ci
npm run typecheck
npm test
npm run build
```

After changing the config schema in `src/model.ts`, run `npm run schemas`. Every merge to `main` releases the next patch version.
