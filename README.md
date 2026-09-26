# difff

Review local Git changes in VS Code and collect line comments to share with a coding agent.

## Get started

Install the `.vsix` using **Extensions: Install from VSIX** in the Command Palette. Open a trusted Git folder, then run **difff: Review Changes**. Git must be installed.

Choose what to review:

- **Uncommitted:** all changes since the last commit, including new files.
- **Staged:** changes staged for your next commit.
- **Unstaged:** changes you haven't staged, including new files.

## Review changes

- Click a file on the left or filter by name. Its header arrow opens the editable file on disk in every scope. Deleted files have no arrow.
- Expand hidden lines with the context buttons, or choose **Expand all** for the whole file.
- Search with **Find**. Use `.*` for regex and **Aa** for case sensitivity. Expand context to include hidden lines in search.
- Click **Refresh** after changing files or staging changes. This also collapses expanded context.
- Use the sun or moon button to switch themes.

## Leave comments

Hover a source line, click **+**, write your comment, then **Save**. **Edit** and **Delete** work inline and in the comments panel.

Click a comment in the right panel to jump to its source. Inline **Focus** finds it in the panel. Save or cancel your draft before switching scopes or jumping to another comment.

**Copy comments** copies all comments for the selected repository, across scopes, ready to paste into an agent:

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
