import * as vscode from "vscode";
import simpleGit, { SimpleGit, DiffResult } from "simple-git";
import { execFile } from "child_process";

export class GitService {
  private git: SimpleGit;
  private repositoryRoot?: Promise<string>;

  constructor() {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      throw new Error("No workspace folder found");
    }
    this.git = simpleGit(workspaceFolder.uri.fsPath);
  }

  async getAllRefs(): Promise<string[]> {
    try {
      const refs: string[] = [];

      // Add HEAD
      refs.push("HEAD");

      // Get branches
      try {
        const branches = await this.git.branch(["-a"]);

        // Add local branches
        Object.keys(branches.branches).forEach((branch) => {
          if (!branch.startsWith("remotes/")) {
            if (!refs.includes(branch)) {
              refs.push(branch);
            }
          }
        });

        // Add remote branches
        Object.keys(branches.branches).forEach((branch) => {
          if (branch.startsWith("remotes/")) {
            const cleanBranch = branch
              .replace("remotes/origin/", "")
              .replace("remotes/", "");
            if (!refs.includes(cleanBranch) && cleanBranch !== "HEAD") {
              refs.push(`origin/${cleanBranch}`);
            }
          }
        });
      } catch (err) {
        console.log("Could not get branches:", err);
      }

      // Get tags
      try {
        const tags = await this.git.tags();
        tags.all.forEach((tag) => {
          refs.push(`tag/${tag}`);
        });
      } catch (err) {
        console.log("Could not get tags:", err);
      }

      // Get recent commits
      try {
        const log = await this.git.log({ maxCount: 20 });
        log.all.slice(0, 10).forEach((commit) => {
          const shortMessage = commit.message.split("\n")[0].substring(0, 50);
          refs.push(`${commit.hash.substring(0, 7)} - ${shortMessage}`);
        });
      } catch (err) {
        console.log("Could not get commits:", err);
      }

      // Remove duplicates and empty values
      const uniqueRefs = [...new Set(refs)].filter((ref) => ref && ref.trim());

      // If no refs found, return defaults
      if (uniqueRefs.length === 0) {
        return ["HEAD"];
      }

      return uniqueRefs;
    } catch (error) {
      console.error("Error getting refs:", error);
      return ["HEAD"];
    }
  }

  async getDiff(baseRef: string, compareRef: string): Promise<DiffResult> {
    try {
      const base = this.parseRef(baseRef);
      const compare = this.parseRef(compareRef);
      const diff = await this.git.diff([
        `${base}...${compare}`,
        "--name-status",
      ]);
      return await this.git.diffSummary([`${base}...${compare}`]);
    } catch (error) {
      console.error("Error getting diff:", error);
      throw error;
    }
  }

  async getFileDiff(
    baseRef: string,
    compareRef: string,
    filePath: string,
  ): Promise<string> {
    try {
      const base = this.parseRef(baseRef);
      const compare = this.parseRef(compareRef);

      // Add timeout to prevent hanging
      const timeoutPromise = new Promise<string>((_, reject) => {
        setTimeout(
          () =>
            reject(new Error("Git diff operation timed out after 30 seconds")),
          30000,
        );
      });

      const diffPromise = this.git.diff([
        `${base}...${compare}`,
        "--",
        filePath,
      ]);

      return await Promise.race([diffPromise, timeoutPromise]);
    } catch (error) {
      console.error("Error getting file diff:", error);
      throw error; // Re-throw to handle in extension
    }
  }

  async getDiffFiles(
    baseRef: string,
    compareRef: string,
  ): Promise<
    Array<{
      path: string;
      status: string;
      additions: number;
      deletions: number;
    }>
  > {
    try {
      const base = this.parseRef(baseRef);
      const compare = this.parseRef(compareRef);

      // Add timeout to prevent hanging
      const timeoutPromise = new Promise<any>((_, reject) => {
        setTimeout(
          () =>
            reject(
              new Error(
                "Git diff summary operation timed out after 30 seconds",
              ),
            ),
          30000,
        );
      });

      const diffPromise = this.git.diffSummary([`${base}...${compare}`]);
      const diffSummary = await Promise.race([diffPromise, timeoutPromise]);

      return diffSummary.files.map((file: any) => ({
        path: file.file,
        status: this.getFileStatus(file),
        additions: ("insertions" in file ? file.insertions : 0) || 0,
        deletions: ("deletions" in file ? file.deletions : 0) || 0,
      }));
    } catch (error) {
      console.error("Error getting diff files:", error);
      throw error; // Re-throw to handle in extension
    }
  }

  private parseRef(ref: string): string {
    if (ref.includes(" - ")) {
      return ref.split(" - ")[0];
    }
    if (ref.startsWith("tag/")) {
      return ref;
    }
    return ref;
  }

  private parseShortStatus(status: string): string {
    // Git status --short format: XY filename
    // X = staged status, Y = working tree status
    // ' ' = unmodified, M = modified, A = added, D = deleted, R = renamed, C = copied, U = updated but unmerged, ? = untracked, ! = ignored

    const stagedStatus = status[0];
    const workingTreeStatus = status[1];

    if (stagedStatus === "?" && workingTreeStatus === "?") {
      return "untracked";
    }

    if (stagedStatus === "A" || workingTreeStatus === "A") {
      return "added";
    }

    if (stagedStatus === "D" || workingTreeStatus === "D") {
      return "deleted";
    }

    if (stagedStatus === "R" || workingTreeStatus === "R") {
      return "renamed";
    }

    if (stagedStatus === "M" || workingTreeStatus === "M") {
      return "modified";
    }

    if (stagedStatus === "C" || workingTreeStatus === "C") {
      return "copied";
    }

    return "modified"; // fallback
  }

  private getFileStatus(file: any): string {
    if (file.binary) return "binary";
    const deletions = "deletions" in file ? file.deletions : 0;
    const insertions = "insertions" in file ? file.insertions : 0;
    if (deletions === 0 && insertions > 0) return "added";
    if (insertions === 0 && deletions > 0) return "deleted";
    return "modified";
  }

  async getWorkingDirectoryDiff(): Promise<string> {
    try {
      const files = await this.getWorkingDirectoryFiles();
      const diffs = await Promise.all(
        files.map((file) =>
          this.getWorkingDirectoryFileDiff(
            file.path,
            file.status === "untracked",
          ),
        ),
      );
      return diffs.filter(Boolean).join("\n");
    } catch (error) {
      console.error("Error getting working directory diff:", error);
      return "";
    }
  }

  async getWorkingDirectoryFiles(): Promise<
    Array<{
      path: string;
      status: string;
      additions: number;
      deletions: number;
    }>
  > {
    try {
      const git = await this.getWorkingTreeGit();
      // simple-git parses NUL-delimited porcelain, including quoted paths and renames.
      const status = await git.status(["--untracked-files=all"]);

      const files: Array<{
        path: string;
        status: string;
        additions: number;
        deletions: number;
      }> = [];

      for (const file of status.files) {
        const filePath = file.path;
        const fileStatus = this.parseShortStatus(file.index + file.working_dir);

        // Get diff stats for the file
        let additions = 0;
        let deletions = 0;

        try {
          const fileDiff = await this.getWorkingDirectoryFileDiff(
            filePath,
            fileStatus === "untracked",
          );
          let inHunk = false;
          for (const diffLine of fileDiff.split("\n")) {
            if (diffLine.startsWith("diff --git ")) {
              inHunk = false;
            } else if (diffLine.startsWith("@@ ")) {
              inHunk = true;
            } else if (inHunk) {
              if (diffLine.startsWith("+")) {
                additions++;
              }
              if (diffLine.startsWith("-")) {
                deletions++;
              }
            }
          }
        } catch (err) {
          // If we can't get diff stats, use defaults (0/0)
          console.warn(`Could not get diff stats for ${filePath}:`, err);
        }

        files.push({
          path: filePath,
          status: fileStatus,
          additions,
          deletions,
        });
      }

      return files;
    } catch (error) {
      console.error("Error getting working directory files:", error);
      throw error; // Re-throw to handle in extension
    }
  }

  private getRepositoryRoot(): Promise<string> {
    this.repositoryRoot ??= this.git
      .revparse(["--show-toplevel"])
      .then((root) => root.trim());
    return this.repositoryRoot;
  }

  private async getWorkingTreeGit(): Promise<SimpleGit> {
    // Porcelain paths are relative to the repository root, even for a nested workspace.
    return simpleGit({
      baseDir: await this.getRepositoryRoot(),
      timeout: { block: 30000 },
    });
  }

  private async getUntrackedFileDiff(filePath: string): Promise<string> {
    const root = await this.getRepositoryRoot();
    return new Promise((resolve, reject) => {
      execFile(
        "git",
        [
          "diff",
          "--no-index",
          "--no-ext-diff",
          "--no-textconv",
          "--no-color",
          "--",
          "/dev/null",
          filePath,
        ],
        {
          cwd: root,
          encoding: "utf8",
          timeout: 30000,
          maxBuffer: 50 * 1024 * 1024,
          windowsHide: true,
        },
        (error, stdout) => {
          // --no-index returns 1 for a successful comparison that found differences.
          if (error && error.code !== 1) {
            reject(error);
          } else {
            resolve(stdout);
          }
        },
      );
    });
  }

  async getWorkingDirectoryFileDiff(
    filePath: string,
    untracked?: boolean,
  ): Promise<string> {
    try {
      const git = await this.getWorkingTreeGit();
      const literalPath = `:(literal)${filePath}`;
      if (untracked === undefined) {
        const untrackedPaths = await git.raw([
          "ls-files",
          "--others",
          "--exclude-standard",
          "-z",
          "--",
          literalPath,
        ]);
        untracked = untrackedPaths.split("\0").includes(filePath);
      }
      if (untracked) {
        return await this.getUntrackedFileDiff(filePath);
      }

      const diffOptions = ["--no-ext-diff", "--no-textconv", "--no-color"];
      const stagedDiff = await git.diff([
        ...diffOptions,
        "--staged",
        "--",
        literalPath,
      ]);
      const unstagedDiff = await git.diff([...diffOptions, "--", literalPath]);

      // Combine both diffs
      let combinedDiff = "";
      if (stagedDiff.trim()) {
        combinedDiff += stagedDiff;
      }
      if (unstagedDiff.trim()) {
        if (combinedDiff) combinedDiff += "\n";
        combinedDiff += unstagedDiff;
      }

      return combinedDiff;
    } catch (error) {
      console.error("Error getting working directory file diff:", error);
      throw error; // Re-throw to handle in extension
    }
  }

  async getCurrentCommitHash(): Promise<string> {
    try {
      const log = await this.git.log({ maxCount: 1 });
      return log.latest?.hash || "HEAD";
    } catch (error) {
      console.error("Error getting current commit hash:", error);
      return "HEAD";
    }
  }
}
