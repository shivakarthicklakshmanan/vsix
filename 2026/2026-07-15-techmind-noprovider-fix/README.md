# TechMind Studio — "no data provider registered" fix (2026-07-15)

Self-contained, fixed snapshot of the TechMind Studio VS Code extension for
airgapped install. Built with `python make_vsix.py` (no Node, no network).

## The error

The sidebar panels (Workflows / Tools / Models, and any additional views) showed:

> There is no data provider registered that can provide view data.

### Root cause

`package.json` had `"activationEvents": []`. The extension's `activate()` — where
every `registerTreeDataProvider(...)` call lives — was not being run, so VS Code
had no data provider for the contributed views and rendered the empty-state error
under each panel.

### Fix

```jsonc
"activationEvents": [
  "onStartupFinished"
]
```

This guarantees `activate()` runs on startup, registering the Workflows, Tools and
Models tree data providers, so the panels populate instead of showing the error.

## Also included in this build

The new **Agent panel** (`out/agentPanel.js` / `src/agentPanel.ts`) with:

- 📎 Attach button + file picker (`openFilePicker` → `attachFileFromPicker`)
- Text / image / PDF attachments (base64), sent as a multimodal `content` array
  to the vLLM gateway when images/PDFs are attached.
- `ChatMessage.content` widened to `string | any[]` in `llmRegistry.ts` to carry
  the multimodal payload.

## Contents

| Path | Notes |
|------|-------|
| `techmind-studio-1.0.0.vsix` | Rebuilt, fixed package — install via Extensions → … → Install from VSIX |
| `package.json` | Fixed manifest (`activationEvents`) |
| `src/` | Fixed TypeScript sources |
| `out/` | Compiled JS shipped in the vsix |
| `media/` | Extension icon |
| `make_vsix.py` | Python packager (used to build the vsix) |

## Rebuild

```
python make_vsix.py
```

Produces `techmind-studio-1.0.0.vsix` in this folder.
