# Armory

Git repo workspace manager. Armory recursively clones a set of dependency repositories, keeps them updated, and generates VS Code multi-root workspaces plus local `.gitignore` entries.

## Requirements

- [Node.js](https://nodejs.org/) 22 or newer (runs `armory.ts` with native TypeScript)
- `git` on your `PATH`

## Initial setup

In the project directory where you want Armory to live (alongside `armory.json`), download the script from GitHub:

**macOS / Linux / Git Bash**

```bash
curl -fsSL -o armory.ts https://raw.githubusercontent.com/StarCruiseStudios/Armory/main/armory.ts
```

**PowerShell**

```powershell
Invoke-WebRequest -Uri "https://raw.githubusercontent.com/StarCruiseStudios/Armory/main/armory.ts" -OutFile armory.ts
```

Create an `armory.json` in the same directory:

```bash
node armory.ts init
```

First-time sync (clone dependencies, fetch, pull, write workspace):

```bash
node armory.ts sync
```

Open the generated `<workspaceName>.armory.code-workspace` file in VS Code or Cursor.

## Usage

Run commands from the directory that contains `armory.json`:

| Command | Description |
| --- | --- |
| `node armory.ts init` | Create `armory.json` in the current directory. |
| `node armory.ts clone` | Recursively clone configured repos that are missing under each `reposRoot`. |
| `node armory.ts fetch` | Recursively run `git fetch --all --prune` in each configured repo. |
| `node armory.ts pull` | Recursively run `git pull --ff-only` in each configured repo. |
| `node armory.ts sync` | Recursively run `clone`, then `fetch`, then `pull` (typical full update or initial setup). |
| `node armory.ts update` | Replace the running `armory.ts` with the latest version from GitHub. |
| `node armory.ts --help` | Prints usage details. |

Armory will:

- Create or update `<workspaceName>.armory.code-workspace` next to the `armory.json`.
- Look for `armory.json` at each configured `repoPath` and applies the same command to that dependency tree.
- Processes a discovered `armory.json` only once when multiple dependency paths lead to the same file
- Update managed `.gitignore` block(s).

## Configuration

| Field | Required | Description |
| --- | --- | --- |
| `workspaceName` | yes | Base name for `<workspaceName>.armory.code-workspace`. |
| `repos` | no | List of repos to clone. Defaults to `[]` when omitted. |
| `repos[].url` | yes | Git clone URL. |
| `repos[].branch` | no | Branch to clone (default: `main`). |
| `repos[].repoPath` | no | Subpath inside the clone to add as a workspace folder (default: `./`). |
| `reposRoot` | no | Where repos are cloned, as `<reposRoot>/<owner>/<repository>` (nested groups keep their extra path segments). Relative to `armory.json` or absolute. When omitted, Armory uses the `ARMORY_ROOT` environment variable, then `~/armory`. |
| `excludeLocalDir` | no | If `true`, omit the armory directory from the workspace file. |
| `skipArmoryTasks` | no | If `true`, omit `Armory: …` shell tasks from the workspace file.|
| `workspaceSettings` | no | Extra VS Code workspace JSON (settings, launch configs, additional `folders`, `tasks`, etc.). |

