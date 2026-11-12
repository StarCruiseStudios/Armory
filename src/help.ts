export const HELP = `Usage: armory <command>

Run dependency commands from the directory that contains armory.json.
The update command can run from any directory.

Commands:
  init       Create armory.json here if it does not already exist.
  clone      Recursively clone missing repos under reposRoot.
  fetch      Recursively fetch all configured repositories.
  pull       Recursively pull all configured repositories.
  sync       Recursively clone, then pull.
  update     Update armory: pull and rebuild a linked checkout, or install the latest from npm.

Options:
  --help            Show help
  --version         Show the installed version

armory.json workspace and repository configuration:
{
    "workspaceName": "name", // Required. Names <workspaceName>.armory.code-workspace.
    "repos": [ // Optional. Repositories to clone. Defaults to [].
        {
            "url": "https://github.com/org/repo.git", // Required. Git clone URL.
            "branch": "main", // Optional. When set, clone that branch into <owner>/<repo>-<branch>. When omitted, use the remote default at <owner>/<repo>.
            "repoPath": "./" // Optional. Subpath added as a workspace folder. Defaults to ./.
        }
    ],
    "reposRoot": "~/armory", // Optional. Clone directory. Each repo is placed at <reposRoot>/<owner>/<name>. Relative to armory.json or absolute. Defaults to ARMORY_ROOT, then ~/armory.
    "excludeLocalDir": false, // Optional. If true, omit this directory from the workspace.
    "skipArmoryTasks": false, // Optional. If true, omit Armory shell tasks from the workspace.
    "workspaceSettings": {} // Optional. Extra VS Code workspace JSON merged into the generated workspace file.
}
`;
