# Agent rules

- Activate the development environment before running any other commands.
- Do not install dependencies globally. Install them into the project instead, using methods such as vendoring or virtual environments.
- Do not manually wrap prose in markdown or text files. Use newlines only when they serve a structural or semantic purpose.
- Delegate aggressively to well-maintained libraries, even when the current requirement is small or isolated. They usually handle edge cases better and give us a stronger base for future requirements.

# Development

Bootstrap initializes the development environment if needed and activates it.

```powershell
python scripts/bootstrap.py | iex
```

On Linux/macOS:

```sh
eval "$(python scripts/bootstrap.py)"
```

npm commands:

| Command         | Purpose                                      |
| --------------- | -------------------------------------------- |
| `npm run dev`   | Watch changes and open a development host.   |
| `npm run check` | Check types and lint.                        |
| `npm test`      | Run the extension-host smoke test.           |
| `npm run build` | Check, build, and package a production VSIX. |

See `package.json` for more commands.
