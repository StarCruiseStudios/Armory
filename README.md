# Armory

Armory is a package manager for modules of source code. It is built for agentic development. You list the Git repositories your project depends on, and Armory clones them, keeps them up to date, and generates a multi-root workspace for VS Code or Cursor. Your project and its modules show up together in one window.

Every module lives on disk as a full repository. A module can hold code, agent skills, instructions, or reference material, and you add it to the projects that need it. An agent working in your project can read a module's source to see how it works and how to use it. When a module needs a small change or an extra feature, the agent edits it in place and builds it. The change is ready to use as soon as the build finishes.

## Why use it

Agents work better when they can read the code they are calling. With the source checked out locally, an agent can see how a module is implemented and follow its patterns. The usage it writes then matches what the module really does.

Iteration is fast. If a module needs a small change or an extra feature, you make the edit in the clone and build it. Your project picks up the result immediately.

A module can also carry agent skills, instructions, and reference material. Packaging them in a repository makes them reusable. You add that repository to any project that needs them, and the agent picks them up when it works there.

Modules can build on each other. Any module can have its own `armory.json` that lists more repositories. When you run `sync`, Armory follows that whole tree to keep all of your dependencies up to date.

## How it fits together

Each project keeps a small list of the modules it uses. Armory reads that list and brings every module onto your machine, so all of your projects can share one set of checkouts. A module can list modules of its own, and Armory follows those links until the whole chain is in place.

Armory then builds a workspace that opens your project and its modules side by side. Your editor and your agent see the same view, so the agent can browse a module's source, follow its conventions, and make changes alongside your own. The checkouts stay out of your project's repository, which keeps your history focused on your own work.

When a module improves, you sync to pick up the latest version. When your project needs something different from a module, you change it right there and keep working. This makes a module part of your normal development loop, and it stays available to every project that adds it.

## Requirements

- [Node.js](https://nodejs.org/) 22 or newer. Armory runs `armory.ts` using native TypeScript support.
- `git` on your `PATH`.

## Setup

Go to your project directory and download the script from GitHub. The same directory will hold `armory.json`.

**macOS / Linux / Git Bash**

```bash
curl -fsSL -o armory.ts https://raw.githubusercontent.com/StarCruiseStudios/Armory/main/armory.ts
```

**PowerShell**

```powershell
Invoke-WebRequest -Uri "https://raw.githubusercontent.com/StarCruiseStudios/Armory/main/armory.ts" -OutFile armory.ts
```

Next, create a starter config:

```bash
node armory.ts init
```

Edit `armory.json` to list the repositories you want, then run a full sync. The sync clones anything missing, fetches, pulls, and writes the workspace file.

```bash
node armory.ts sync
```

Finally, open `<workspaceName>.armory.code-workspace` in VS Code or Cursor. After that, you will run `sync` most often to stay current.

## Commands

Run these from the directory that contains `armory.json`.

| Command | Description |
| --- | --- |
| `node armory.ts init` | Creates `armory.json` in the current directory when it does not exist yet. |
| `node armory.ts clone` | Recursively clones configured repos that are missing under each `reposRoot`. |
| `node armory.ts fetch` | Recursively runs `git fetch --all --prune` in each configured repo. |
| `node armory.ts pull` | Recursively runs `git pull --ff-only` in each configured repo. |
| `node armory.ts sync` | Recursively runs `clone`, then `fetch`, then `pull`. This is the usual command for first-time setup and routine updates. |
| `node armory.ts update` | Replaces `armory.ts` with the latest version from GitHub. |
| `node armory.ts --help` | Prints usage details. |

When you run `clone`, `fetch`, `pull`, or `sync`, Armory also does a few things for you:

- It creates or updates `<workspaceName>.armory.code-workspace` beside `armory.json`.
- It looks for an `armory.json` at each configured `repoPath` and runs the same command on that dependency tree.
- It skips any `armory.json` it has already processed. Shared dependencies are handled once.
- It updates the managed `.gitignore` blocks so local clone paths stay ignored when they fall inside a Git repository.

The generated workspace also includes **Armory** shell tasks for clone, fetch, pull, sync, and update. You can run the tool from inside the editor with them.

## Configuration

`armory.json` holds your workspace name, the location for clones, and the repositories to include.

| Field | Required | Description |
| --- | --- | --- |
| `workspaceName` | yes | Base name for `<workspaceName>.armory.code-workspace`. |
| `repos` | no | Repositories to clone. Defaults to `[]` when omitted. |
| `repos[].url` | yes | Git clone URL. |
| `repos[].branch` | no | Branch to clone. When set, the clone goes into `<reposRoot>/<owner>/<repository>-<branch>`. When omitted, Armory clones the remote's default branch into `<reposRoot>/<owner>/<repository>`. |
| `repos[].repoPath` | no | Subpath inside the clone to add as a workspace folder. Defaults to `./`. |
| `reposRoot` | no | Directory that holds the clones, laid out as `<reposRoot>/<owner>/<repository>` (with `-<branch>` appended when `branch` is set, and nested groups keeping their extra path segments). It can be relative to `armory.json` or absolute. When omitted, Armory uses `ARMORY_ROOT`, then `~/armory`. |
| `excludeLocalDir` | no | If `true`, leaves the directory that contains `armory.json` out of the workspace file. |
| `skipArmoryTasks` | no | If `true`, leaves the **Armory** shell tasks out of the workspace file. |
| `workspaceSettings` | no | Extra VS Code workspace JSON that Armory merges into the generated file. It can include settings, launch configs, additional `folders`, and `tasks`. |

Here is a small example config:

```json
{
  "workspaceName": "MyApp",
  "repos": [
    {
      "url": "https://github.com/org/shared-module.git"
    },
    {
      "url": "https://github.com/org/experimental.git",
      "branch": "feature-xyz"
    }
  ],
  "workspaceSettings": {
    "settings": {
      "editor.formatOnSave": true
    }
  }
}
```
