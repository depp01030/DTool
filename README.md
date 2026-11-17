# Mini Notes v0.1 — Windows 輕量待辦＋筆記

一個小型、完全離線的 Windows 桌面小工具，使用 JavaScript、Tiptap 及 Tauri 2。

## 功能

- 視窗右上角「📌 已置頂／未置頂」可隨時切換永遠置頂；重新開啟會記住設定。
- 小筆記、多筆切換、修改標題、新增及刪除。
- 使用待辦 Checkbox、粗體、斜體、一般項目清單。
- 在一般段落中：`Tab` 插入四個不換行空格，`Space` 插入一般一格空白。
- 待辦清單中：`Tab` / `Shift+Tab` 用來增加／減少巢狀縮排。
- 插圖：`Ctrl+V`、工具列「圖片」、從桌面拖入圖片。Tauri 視窗已設定 `dragDropEnabled: false`，讓 Windows WebView2 接收 HTML5 Drop 事件。
- 編輯器中的圖片會直接顯示，可以拖到其他段落，並用角落控制點調整大小。
- 自動儲存至本機 IndexedDB（與程式一起由 WebView2 管理），不需要網路與帳號。
- 圖片會轉為 WebP（最長邊上限 1600 px）並嵌在筆記中保存。GIF 維持原格式。

## Windows 執行方式

首次開發需要：

1. Node.js 20+；
2. Rust (`rustup`，採 MSVC target)；
3. Visual Studio 2022 C++ Build Tools，安裝「Desktop development with C++」；
4. Microsoft Edge WebView2 Runtime（Windows 11 一般已預裝）。

在此資料夾開啟 PowerShell：

```powershell
npm install
npm run tauri dev
```

建立安裝用 EXE：

```powershell
npm run tauri build
```

輸出通常位於：`src-tauri\target\release\bundle\nsis\`。

也可以用 `npm run dev` 先在瀏覽器預覽編輯功能，但瀏覽器不能真正置頂；置頂必須用 `npm run tauri dev` 開啟桌面版本。

## 資料保存與第一版限制

- 使用 WebView2 的 IndexedDB，資料會保存在本機**應用程式 WebView 的使用者資料目錄**，不會上傳。
- 此版未提供匯入/匯出或雲端同步。重要筆記請勿只保留唯一份本機副本；正式使用前建議加入匯出/備份。
- 刪除筆記目前無垃圾桶，請審慎操作。
- 圖片可以在**同一篇筆記內的段落之間移動與縮放**，不是自由浮動到任意 X/Y 座標。
- 大量高解析度圖片會增加 IndexedDB 容量與編輯器記憶體使用；V2 建議改為獨立的影像檔案儲存。
- 沒有實作系統匣、提醒通知、桌面小工具自動貼邊、全域搜尋和資料庫；刻意保持最小化。
- 這是可編譯的原始碼範本，尚未在真實 Windows 裝置建置或驗證。Windows 的 Tauri exe 無法在目前的 Linux 環境中直接產生。

## 技術實作

- Windows 桌面封裝：Tauri 2 + WebView2
- 前端：Vanilla JS + CSS（不用 React）
- 編輯器：Tiptap 3/ProseMirror
- 小資料：`localStorage`（置頂和畫面偏好）
- 筆記與內嵌圖片：`IndexedDB`（每篇筆記 JSON）

公開文件：
- Tauri: https://v2.tauri.app/
- Tiptap: https://tiptap.dev/docs/editor/