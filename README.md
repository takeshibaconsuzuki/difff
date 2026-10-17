# difff

Review local Git changes in VS Code and collect line comments to share with a coding agent.

## Get started

Install the `.vsix` using **Extensions: Install from VSIX** in the Command Palette. Open a trusted Git folder, then run **difff: Review Changes**. Git must be installed.

Enter the two endpoints and press Enter or **Apply**. Both inputs accept branches, tags, commit hashes, revisions such as `HEAD~3`, and the special values `INDEX` and `WORKING`.

| Review | From | To |
| --- | --- | --- |
| All uncommitted changes (default) | `HEAD` | `WORKING` |
| Staged changes | `HEAD` | `INDEX` |
| Unstaged changes | `INDEX` | `WORKING` |
| Last commit | `HEAD^` | `HEAD` |
| Branch changes since the merge base | `main` | `HEAD` |

Two commit refs use Git's three-dot semantics: changes from their merge base to the end ref. Comparisons between a ref and `INDEX` or `WORKING` start at the merge base of the ref and `HEAD`, so `main` → `WORKING` shows your branch's commits plus local edits, without changes made on `main` since you branched. `WORKING` includes untracked files. Reversing the endpoints reverses local comparisons; for example, `WORKING ? INDEX` shows what would change when returning to the staged contents.

## Review changes

- Click a file on the left or filter by name. Its header arrow opens the editable file on disk and appears only when that path exists as a file in the working directory.
- Renames appear once with an **R** badge and both paths, including moves to untracked files. Filter by either name; file actions and comments use the destination path. When reversing a rename whose original path has an untracked replacement, the affected paths appear as ordinary changes so each has an unambiguous comment location. Rename detection uses Git's content similarity rules and a temporary comparison that leaves your staging area unchanged.
- Expand hidden lines with the context buttons, or choose **Expand all** for the whole file.
- Search with **Find**. Use `.*` for regex and **Aa** for case sensitivity. Expand context to include hidden lines in search.
- Long source lines wrap by default. Use **Toggle word wrap** in the toolbar to change this; your choice is remembered when the review reloads.
- **Ignore whitespace** is on by default, matching `git diff -w`: changes to spaces and tabs within lines are ignored, while added or removed lines remain visible. Turn it off in the toolbar to review whitespace changes. Your choice is remembered when the review reloads.
- Click **Refresh** after changing files or staging changes. This also collapses expanded context.
- Use the sun or moon button to switch themes.

## Leave comments

Hover a source line, click **+**, write your comment, then **Save**. **Edit** and **Delete** work inline and in the comments panel.

Click a comment in the right panel to jump to its source. Inline **Focus** finds it in the panel. Save or cancel your draft before changing comparisons or jumping to another comment.

**Copy comments** copies all comments for the selected repository, across comparisons, ready to paste into an agent:

```text
src/example.ts:42
Handle an empty list here.
```

**Clear all** removes those comments after confirmation.

Comments stay in this VS Code workspace. They remain in the panel if source lines change or move, but may lose their inline location. **Line changed or hidden** can also mean collapsed context; click the comment to reveal it if available.

## Shortcuts

Use Ctrl on Windows/Linux or Cmd on macOS.

| Shortcut | Action |
| --- | --- |
| Ctrl/Cmd+P | Focus the file filter |
| Ctrl/Cmd+F | Focus search |
| Enter / Shift+Enter in search | Next / previous match |
| Ctrl/Cmd+Enter in a comment | Save comment |
| Escape in a comment | Cancel editing |

The toolbar dot is green when review shortcuts are active. If it's grey, click inside the review first.
