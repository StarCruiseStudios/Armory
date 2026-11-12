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

- [Node.js](https://nodejs.org/) 22.18 or newer, which includes `npm`.
- `git` on your `PATH`.

## Setup

Install the `armory` command from npm:

```bash
npm install --global @starcruisestudios/armory
```

Next, go to your project directory and create a starter config:

```bash
armory init
```

Edit `armory.json` to list the repositories you want, then run a full sync. The sync clones anything missing, pulls, and writes the workspace file.

```bash
armory sync
```

Finally, open `<workspaceName>.armory.code-workspace` in VS Code or Cursor. After that, you will run `sync` most often to stay current.

You can also run Armory without installing it by using `npx @starcruisestudios/armory <command>`. The generated editor tasks call `armory` directly, so they need the global install.

## Commands

Run these from the directory that contains `armory.json`.

| Command | Description |
| --- | --- |
| `armory init` | Creates `armory.json` in the current directory, then writes the workspace file and the managed `.gitignore` block. It stops if `armory.json` already exists. |
| `armory clone` | Recursively clones configured repos that are missing under each `reposRoot`. |
| `armory fetch` | Recursively runs `git fetch --all --prune` in each configured repo. |
| `armory pull` | Recursively runs `git pull --ff-only` in each configured repo. |
| `armory sync` | Recursively runs `clone`, then `pull`. This is the usual command for first-time setup and routine updates. |
| `armory update` | Updates Armory itself, from any directory. When Armory runs from a Git checkout, such as one set up with `npm link`, it runs `git pull --ff-only`, `npm install`, and `npm run build` in that checkout. Otherwise it runs `npm install --global @starcruisestudios/armory@latest`. |
| `armory --help` | Prints usage details. |
| `armory --version` | Prints the installed version. |

When you run `clone`, `fetch`, `pull`, or `sync`, Armory also does a few things for you:

- It creates or updates `<workspaceName>.armory.code-workspace` beside `armory.json`.
- It looks for an `armory.json` at each configured `repoPath` and runs the same command on that dependency tree.
- It skips any `armory.json` it has already processed. Shared dependencies are handled once.
- It updates the managed `.gitignore` blocks so the generated workspace file and local clone paths stay ignored when they fall inside a Git repository.

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

## Development

The source lives in `src/` as TypeScript modules. `src/cli.ts` is the `armory` executable and `src/index.ts` is the library entry point. The build compiles them to `dist/`, which is the only directory the published package ships.

| Script | Description |
| --- | --- |
| `npm run build` | Compiles `src/` to `dist/`. |
| `npm run typecheck` | Type-checks the source and the tests. |
| `npm test` | Builds, then runs the tests. Git and npm are stubbed, so the tests stay offline. |

To use a local checkout as the `armory` command, run `npm install`, `npm run build`, and then `npm link`. After that, `armory update` pulls and rebuilds the checkout in place, and the link keeps pointing at it.
