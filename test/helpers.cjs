const Module = require("node:module");

const vscode = { workspace: { workspaceFolders: [] } };
const originalLoad = Module._load;
Module._load = function (id, ...args) {
  return id === "vscode" ? vscode : originalLoad.call(this, id, ...args);
};
let GitService;
let DiffWebviewProvider;
try {
  ({ GitService } = require("../out/gitService"));
  ({ DiffWebviewProvider } = require("../out/webviewProvider"));
} finally {
  Module._load = originalLoad;
}

module.exports = {
  createGitService(root) {
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: root } }];
    return new GitService();
  },
  createWebviewProvider() {
    return new DiffWebviewProvider({});
  },
};
