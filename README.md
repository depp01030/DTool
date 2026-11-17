# Mini Notes v0.2.0 — Portable Windows note widget

A lightweight, offline Windows desktop note / todo app built with Tauri 2 + Tiptap 3 + vanilla JavaScript.

## Download and run (no installation)

Download **Mini-Notes-v0.2.0-Portable-Windows-x64.zip** from [GitHub Releases](https://github.com/depp01030/DTool/releases), extract the entire archive into a writable folder (for example Desktop), then double-click **Mini Notes.exe**.

Do **not** run the executable from inside the ZIP, and do **not** place it under `C:\Program Files`: the portable edition stores user data next to the executable.

Expected folder structure after first run:

```text
Mini Notes/
  Mini Notes.exe
  data/
    notes/
      <note-id>.json
      <note-id>.json.bak
    images/
      <image-id>.webp
      <image-id>.png
    settings.json
    EBWebView/
```

The `data/` directory also holds the WebView2 local profile and cache. Keep the **whole folder** when moving between computers. Back up the entire `data/` directory regularly.

This is a Windows x64 executable, **not** the NSIS installer. No Node.js, npm or Rust setup is required for end users. A compatible Microsoft Edge WebView2 Runtime is required (usually available on Windows 11).

## Features

- Toggle always-on-top from the app header (remembers the state).
- Multiple notes, quick checklists, bold/italic/bullets.
- Tab adds four spaces in normal paragraphs; TaskList Tab / Shift+Tab indent nested items.
- Paste or drag image files into the editor; move and resize inline image blocks.
- Offline auto-save.
- Stores each note separately as JSON, image bytes as image files, and preferences as JSON.
- No external cloud login or network sync.

## Previous installed version v0.1.0 — important migration caveat

**Do not uninstall the old v0.1.0 app or clear its WebView2 data if you still need its notes.**
v0.1.0 stored note and embedded image data in a *different* IndexedDB user profile under `%LOCALAPPDATA%`. The portable v0.2.0 profile is now under its own `data/` folder. The new portable build therefore **cannot automatically discover the installed v0.1.0 notes**. They remain untouched in the old profile; migration/export from that legacy location is not included in this release.

Moving between **portable** installations from v0.2.0 onward: copy the entire extracted Mini Notes folder, including `data/`.

## Development

```powershell
npm install
npm run tauri dev
npm run tauri build -- --no-bundle --config src-tauri/tauri.portable.conf.json
```

The portable-only `appDirectoriesOverride: "./data"` config is deliberately separate from the installer config. All app data stays inside its private dedicated subfolder. Image files are stored in `data/images/`, not as Base64 in JSON.

GitHub Actions builds an x64 Windows portable ZIP and publishes it as a release. Interactive Windows GUI testing has not yet been completed.
