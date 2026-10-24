# Pull requests in Pi Web

This fork adds a **PRs** tab to the right panel. It lists the pull requests the
current chat's agent opened, keeps them visible until they are merged or closed,
and lets you merge them without leaving Pi Web. A second scope, **All PRs**,
lists every open pull request of the project's repository.

Upstream Pi Web keeps "a plugin or UI-slot system" and "IDE or Git client
features" out of scope ([CONTRIBUTING](../CONTRIBUTING.md)), so this lives here
as a maintained fork rather than an extension.

## Why it exists

An agent that changes code and then stops is an agent whose work is one
`git checkout` away from being lost. The `pi-pr` extension
([`extensions/pi-pr`](../extensions/pi-pr)) makes the safe ending the default:

- every finished code change is committed, pushed, and published as a pull
  request;
- work that started on `main` is moved sideways into its own worktree and branch
  instead of being pushed to `main`;
- only files the session touched (or that became dirty after it started) are
  ever committed, so your own uncommitted work in the same checkout is never
  swept into an agent PR;
- shipping looks inside the worktrees the session created, so a change made in
  a worktree still gets its pull request even though the chat's directory is
  the clean main checkout;
- questions and read-only investigations are left alone, because they produce
  no changes to ship.

The panel is the window onto that work.

## What the panel shows

- Rows: check state, number, title, draft marker, `branch → base`, author, how
  long ago GitHub last saw activity, and the diff stat.
- Detail: the description rendered as Markdown, commits/files with expandable
  patches, check state, approvals and change requests, a link to GitHub on the
  pull request itself, and a **Merge** button (squash).
- Scope toggle: **This chat** (default) or **All PRs**.
- Merged and closed pull requests disappear: the list is about work that still
  needs attention. Rows refresh every 30 seconds while the tab is visible.

## How a pull request is tied to a chat

The extension writes a `pi.pr` entry into the session file when it opens a pull
request:

```json
{"type":"custom","customType":"pi.pr","data":{"repo":"owner/name","number":42,"url":"…","branch":"agent/fix-login","base":"main","worktree":"/repo-worktrees/agent-fix-login"}}
```

`GET /api/prs?scope=session&session=<id>` reads those entries from the
conversation, so the association survives restarts and travels with the session
file. Nothing is stored in a separate database, and a chat cannot show another
chat's pull requests.

## Agent protocol

Every session gets a "Work preservation (pi-pr)" section in its system prompt and
three tools:

| Tool | Purpose |
|---|---|
| `pr_worktree` | Create the branch and worktree for a change before files are edited. The worktree is recorded in the session as a `pi.pr.worktree` entry so `pr_ship` can find it later. |
| `pr_ship` | Commit, push, and open (or reuse) the pull request. On `main` it first moves the work into its own worktree. |
| `pr_status` | Repository, branch, uncommitted files, unpushed commits, and the chat's pull requests. |

Two guards enforce the protocol:

- `bash`/`powershell` calls that would `git push` to `main`/`master` are blocked
  with a pointer to `pr_ship`.
- Before a run settles, the extension inspects the checkout. Uncommitted files,
  commits that are not on `origin/<base>`, a pushed branch without a pull
  request, or a branch whose pull request failed to open each append a reminder
  and continue the run. Two reminders per run, then it stops, so a run cannot
  loop.

`/prs` prints the same status in the terminal UI; `/ship` ships on demand.

## Requirements

- A `github.com` `origin` remote.
- A token with `repo` scope in `GITHUB_TOKEN`, `~/.pi-git-credentials` (what
  `git config credential.helper store` writes), or `gh auth login`'s hosts file.
  The panel never sends the token to the browser: all GitHub calls happen in the
  server process.

## API

| Route | Purpose |
|---|---|
| `GET /api/prs?scope=session\|all&session=<id>&cwd=<path>` | The list. `cwd` goes through the same allowed-roots check as the git routes. |
| `GET /api/prs/<number>?repo=owner/name&session=<id>` | Description, files, truncated patches, checks, reviews. |
| `POST /api/prs/<number>/merge` `{repo, method}` | Merge. Same origin/content-type checks as the other writing routes. |

Errors come back as `{error, code}` with `code` one of `no-repo`, `no-token`,
`no-session`, `not-found`, `github`, so the panel can explain the fix instead of
showing a raw failure.

## Running this fork

The published `@agegr/pi-web` ships a prebuilt `.next` and no source, so this
fork is deployed as a normal build of this repository:

```bash
npm install
npm run build
npm start          # http://127.0.0.1:30141
```

`main` mirrors `agegr/pi-web`; the pull request work lives on
`pull-requests`, which is this repository's default branch. To take upstream
changes:

```bash
git fetch upstream
git rebase upstream/main
npm install && npm run build
```

## Limitations

- Patches over 12 000 characters are cut in the panel; GitHub has the rest.
- Only `github.com` remotes are understood (not GitHub Enterprise hosts).
- The merge button squashes. `POST /api/prs/<number>/merge` also accepts
  `merge` and `rebase`.
- The guard inspects the session's working directory and the worktrees it
  created. A branch pushed by hand from somewhere else is only recognised when
  it is named in a `pr_ship` call (`branch` argument) or recorded in the
  session.
- A file that was already dirty when the session started is treated as yours,
  not the agent's: the guard will not insist on shipping it.
