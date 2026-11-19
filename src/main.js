import { Editor, Extension } from '@tiptap/core';
import { StarterKit } from '@tiptap/starter-kit';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { Image } from '@tiptap/extension-image';
import { Placeholder } from '@tiptap/extension-placeholder';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { emitTo } from '@tauri-apps/api/event';
import { allNotes, deleteNote, openDatabase, saveNote, storeImage, loadSettings, saveSettings, getRecoveryMessages } from './storage';
import './style.css';

const $ = (selector) => document.querySelector(selector);
const inTauri = typeof window.__TAURI_INTERNALS__ !== 'undefined';
const pending = new Map();
const writeQueues = new Map();
const deletingIds = new Set();
const deletedIds = new Set();
const state = {
  notes: [],
  activeId: null,
  editor: null,
  settingContent: false,
  pinned: localStorage.getItem('mini_notes_pinned') !== 'false',
  collapsed: localStorage.getItem('mini_notes_collapsed') === 'true',
};

function emptyContent() {
  return { type: 'doc', content: [{ type: 'paragraph' }] };
}

function firstContent() {
  return {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: '歡迎使用 Mini Notes！可在這裡記錄小筆記與待辦事項。' }] },
      { type: 'taskList', content: [
        { type: 'taskItem', attrs: { checked: false }, content: [{ type: 'paragraph', content: [{ type: 'text', text: '試著勾選這個待辦事項' }] }] },
        { type: 'taskItem', attrs: { checked: false }, content: [{ type: 'paragraph', content: [{ type: 'text', text: '用 Ctrl+V 貼上圖片，雙擊圖片可開啟獨立檢視器' }] }] },
      ] },
      { type: 'paragraph', content: [{ type: 'text', text: '一般文字按 Tab 插入四格縮排，按空白鍵插入一格。' }] },
    ],
  };
}

function createNote(title = '新筆記', content = emptyContent()) {
  const now = Date.now();
  return { id: crypto.randomUUID(), title, content, createdAt: now, updatedAt: now };
}

function currentNote() {
  return state.notes.find((note) => note.id === state.activeId);
}

function errorText(error) {
  if (error instanceof Error) return error.message || String(error);
  if (typeof error === 'string') return error;
  try { return JSON.stringify(error) || String(error); } catch { return String(error); }
}

function setStatus(message, error = false) {
  const element = $('#save-status');
  element.textContent = message;
  element.classList.toggle('error', error);
}

async function writeNote(note) {
  if (deletedIds.has(note.id) || deletingIds.has(note.id)) return;
  try {
    // Serialize by note ID so older writes cannot overwrite newer edits.
    const snapshot = structuredClone(note);
    const previous = writeQueues.get(note.id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => {
      // The write may have been queued before the user confirmed deletion.
      if (deletedIds.has(note.id) || deletingIds.has(note.id)) return;
      return saveNote(snapshot);
    });
    writeQueues.set(note.id, next);
    try { await next; } finally { if (writeQueues.get(note.id) === next) writeQueues.delete(note.id); }
    if (note.id === state.activeId && !deletingIds.has(note.id)) setStatus('✓ 已自動儲存');
  } catch (error) {
    console.error('Save failed:', error);
    setStatus('儲存失敗：' + errorText(error), true);
  }
}

function scheduleSave(note) {
  if (deletedIds.has(note.id) || deletingIds.has(note.id)) return;
  if (pending.has(note.id)) clearTimeout(pending.get(note.id));
  setStatus('儲存中…');
  const timeout = setTimeout(() => {
    pending.delete(note.id);
    void writeNote(note);
  }, 350);
  pending.set(note.id, timeout);
}

async function flushSaves() {
  const ids = [...pending.keys()];
  for (const timeout of pending.values()) clearTimeout(timeout);
  pending.clear();
  await Promise.all(ids.map((id) => state.notes.find((note) => note.id === id)).filter(Boolean).map(writeNote));
}

function renderNotes() {
  const list = $('#note-list');
  list.replaceChildren();
  for (const note of [...state.notes].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const button = document.createElement('button');
    button.className = 'note-row' + (note.id === state.activeId ? ' active' : '');
    button.dataset.id = note.id;
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', String(note.id === state.activeId));
    const name = document.createElement('span');
    name.className = 'note-row-title';
    name.textContent = note.title.trim() || '無標題筆記';
    const date = document.createElement('small');
    date.textContent = new Date(note.updatedAt).toLocaleDateString('zh-TW', { month: 'numeric', day: 'numeric' });
    button.append(name, date);
    button.addEventListener('click', () => void selectNote(note.id));
    list.append(button);
  }
}

function refreshActiveRow() {
  const note = currentNote();
  if (!note) return;
  const selected = $('#note-list .note-row.active .note-row-title');
  if (selected) selected.textContent = note.title.trim() || '無標題筆記';
}

async function selectNote(id) {
  if (!state.notes.some((note) => note.id === id)) return;
  // A pending save is completed before changing the active editor.
  const before = currentNote();
  if (before && state.editor && !state.settingContent) {
    before.content = state.editor.getJSON();
    if (pending.has(before.id)) {
      clearTimeout(pending.get(before.id));
      pending.delete(before.id);
      await writeNote(before);
    }
  }
  state.activeId = id;
  localStorage.setItem('mini_notes_active', id);
  persistSettings();
  const note = currentNote();
  state.settingContent = true;
  $('#note-title').value = note.title;
  state.editor.commands.setContent(note.content, { emitUpdate: false });
  state.settingContent = false;
  $('#editor-scroll').scrollTop = 0;
  renderNotes();
  setStatus('✓ 已載入筆記');
}

async function addNote() {
  const note = createNote();
  state.notes.push(note);
  await saveNote(note);
  await selectNote(note.id);
  $('#note-title').focus();
  $('#note-title').select();
}

async function removeActiveNote() {
  const note = currentNote();
  if (!note || deletingIds.has(note.id) || deletedIds.has(note.id)) return;
  if (!window.confirm(`確定刪除「${note.title || '無標題筆記'}」？筆記會移到 data/trash，可以手動復原。`)) return;
  deletingIds.add(note.id);
  const timer = pending.get(note.id);
  if (timer) clearTimeout(timer);
  pending.delete(note.id);
  try {
    // Wait for an already-running save. Otherwise it may recreate a deleted .json.
    const queued = writeQueues.get(note.id);
    if (queued) await queued.catch((error) => console.warn('Pending save failed before deletion:', error));
    const result = await deleteNote(note.id);
    deletedIds.add(note.id);
    state.notes = state.notes.filter((item) => item.id !== note.id);
    if (state.notes.length === 0) {
      const replacement = createNote();
      state.notes.push(replacement);
      await saveNote(replacement);
    }
    const next = [...state.notes].sort((a, b) => b.updatedAt - a.updatedAt)[0];
    state.activeId = null;
    await selectNote(next.id);
    setStatus(result?.warnings?.length ? '已刪除筆記，但部分備份未能移動；請檢查 data/notes' : '✓ 筆記已移到 data/trash');
  } catch (error) {
    console.error('Delete failed:', error);
    setStatus('刪除失敗：' + errorText(error), true);
  } finally {
    deletingIds.delete(note.id);
  }
}

function renderPin() {
  $('#btn-pin').classList.toggle('is-pinned', state.pinned);
  $('#btn-pin').setAttribute('aria-pressed', String(state.pinned));
  $('#pin-icon').textContent = state.pinned ? '📌' : '♧';
  $('#pin-text').textContent = state.pinned ? '已置頂' : '未置頂';
  $('#btn-pin').title = state.pinned ? '取消永遠置頂' : '啟用永遠置頂';
}

async function updatePin(pinned) {
  if (inTauri) {
    try {
      await getCurrentWindow().setAlwaysOnTop(pinned);
    } catch (error) {
      console.error(error);
      setStatus('切換置頂失敗：請確認 Windows 權限', true);
      return;
    }
  }
  state.pinned = pinned;
  localStorage.setItem('mini_notes_pinned', String(pinned));
  persistSettings();
  renderPin();
  if (!inTauri) setStatus('瀏覽器預覽：置頂功能僅在 Windows 程式中有效');
}

function renderSidebar() {
  $('#sidebar').classList.toggle('collapsed', state.collapsed);
  $('#btn-sidebar').setAttribute('aria-expanded', String(!state.collapsed));
}

function persistSettings() {
  if (!inTauri) return;
  void saveSettings({
    pinned: state.pinned,
    collapsed: state.collapsed,
    activeId: state.activeId,
  }).catch((error) => console.error('Settings save failed:', error));
}

const StoredImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      storageKey: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-mini-storage'),
        renderHTML: (attributes) => attributes.storageKey ? { 'data-mini-storage': attributes.storageKey } : {},
      },
    };
  },
});

const TabIndent = Extension.create({
  name: 'tabIndent',
  addKeyboardShortcuts() {
    return {
      Tab: () => {
        if (this.editor.isActive('taskItem') && this.editor.commands.sinkListItem('taskItem')) return true;
        if (this.editor.isActive('listItem') && this.editor.commands.sinkListItem('listItem')) return true;
        return this.editor.commands.insertContent('\u00a0'.repeat(4));
      },
      'Shift-Tab': () => {
        if (this.editor.isActive('taskItem')) return this.editor.commands.liftListItem('taskItem');
        if (this.editor.isActive('listItem')) return this.editor.commands.liftListItem('listItem');
        return false;
      },
    };
  },
});

async function fileAsImageData(file) {
  if (!file.type.startsWith('image/')) throw new Error('只接受圖片檔案');
  if (file.size > 32 * 1024 * 1024) throw new Error('單張圖片限制 32MB');
  // Preserve original bytes/resolution in data/images; only the note display is resized.
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('無法讀取圖片'));
    reader.readAsDataURL(file);
  });
}

let openingImageViewer = false;
const imageStoragePattern = /^images\/[a-f0-9-]{36}\.(png|jpg|webp|gif|svg)$/;

async function openFullImage(image) {
  const key = image.getAttribute('data-mini-storage');
  if (!inTauri || !key) {
    if (image.src) window.open(image.src, '_blank', 'noopener');
    return;
  }
  if (!imageStoragePattern.test(key) || openingImageViewer) return;
  openingImageViewer = true;
  try {
    const existing = await WebviewWindow.getByLabel('image-viewer');
    if (existing) {
      await emitTo('image-viewer', 'mini-notes:show-image', { key });
      await existing.setFocus();
      return;
    }
    const viewer = new WebviewWindow('image-viewer', {
      url: 'viewer.html?image=' + encodeURIComponent(key),
      title: 'Mini Notes - 圖片檢視器',
      width: 1050,
      height: 730,
      minWidth: 450,
      minHeight: 330,
      center: true,
      decorations: true,
      resizable: true,
      alwaysOnTop: true,
    });
    viewer.once('tauri://error', (event) => {
      console.error('Image viewer window failed:', event);
      setStatus('無法開啟圖片檢視器', true);
    });
  } catch (error) {
    console.error(error);
    setStatus('無法開啟圖片檢視器：' + error.message, true);
  } finally {
    openingImageViewer = false;
  }
}

async function insertImages(files, pos) {
  const images = [...files].filter((file) => file.type.startsWith('image/'));
  if (!images.length) return;
  for (const file of images) {
    try {
      setStatus('正在匯入圖片…');
      const src = await fileAsImageData(file);
      const storageKey = await storeImage(src);
      const node = { type: 'image', attrs: { src, alt: file.name || '圖片', storageKey } };
      if (typeof pos === 'number') {
        state.editor.chain().focus().insertContentAt(pos, node).run();
        pos += 1;
      } else {
        state.editor.chain().focus().insertContent(node).run();
      }
    } catch (error) {
      setStatus(`圖片匯入失敗：${error.message}`, true);
    }
  }
}

function initEditor() {
  state.editor = new Editor({
    element: $('#editor'),
    extensions: [
      StarterKit,
      TaskList,
      TaskItem.configure({ nested: true }),
      StoredImage.configure({ inline: false, allowBase64: true, resize: { enabled: true } }),
      Placeholder.configure({ placeholder: '開始輸入文字、待辦事項或貼上圖片…' }),
      TabIndent,
    ],
    content: emptyContent(),
    editorProps: {
      attributes: { class: 'tiptap note-content', spellcheck: 'true' },
      handleDOMEvents: {
        dblclick(_view, event) {
          const image = event.target instanceof Element ? event.target.closest('img[data-mini-storage]') : null;
          if (!image) return false;
          event.preventDefault();
          void openFullImage(image);
          return true;
        },
      },
      handlePaste(view, event) {
        const files = [...(event.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
        if (!files.length) return false;
        void insertImages(files);
        return true;
      },
      handleDrop(view, event, slice, moved) {
        // Internal image moves belong to ProseMirror, not the file importer.
        if (moved) return false;
        const files = [...(event.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith('image/'));
        if (!files.length) return false;
        const coords = view.posAtCoords({ left: event.clientX, top: event.clientY });
        void insertImages(files, coords?.pos);
        return true;
      },
    },
    onUpdate({ editor }) {
      if (state.settingContent) return;
      const note = currentNote();
      if (!note) return;
      note.content = editor.getJSON();
      note.updatedAt = Date.now();
      scheduleSave(note);
    },
  });
}

function wireButtons() {
  $('#btn-new').addEventListener('click', () => void addNote());
  $('#btn-new-main').addEventListener('click', () => void addNote());
  window.addEventListener('keydown', (event) => {
    if (event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey && event.key.toLowerCase() === 'n') {
      event.preventDefault();
      void addNote();
    }
  });
  $('#btn-delete').addEventListener('click', () => void removeActiveNote());
  $('#btn-pin').addEventListener('click', () => void updatePin(!state.pinned));
  $('#btn-sidebar').addEventListener('click', () => {
    state.collapsed = !state.collapsed;
    localStorage.setItem('mini_notes_collapsed', String(state.collapsed));
    persistSettings();
    renderSidebar();
  });
  $('#note-title').addEventListener('input', (event) => {
    const note = currentNote();
    if (!note) return;
    note.title = event.target.value;
    note.updatedAt = Date.now();
    scheduleSave(note);
    refreshActiveRow();
  });
  document.querySelectorAll('[data-command]').forEach((button) => {
    // Keep the selected text when clicking a formatting button.
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', () => {
      const command = button.dataset.command;
      if (command === 'task') state.editor.chain().focus().toggleTaskList().run();
      if (command === 'bold') state.editor.chain().focus().toggleBold().run();
      if (command === 'italic') state.editor.chain().focus().toggleItalic().run();
      if (command === 'bullet') state.editor.chain().focus().toggleBulletList().run();
      if (command === 'image') $('#file-input').click();
    });
  });
  $('#file-input').addEventListener('change', (event) => {
    void insertImages(event.target.files);
    event.target.value = '';
  });
  document.addEventListener('dragover', (event) => {
    if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
  });
  document.addEventListener('drop', (event) => {
    if (event.dataTransfer?.files.length) event.preventDefault();
  });
  window.addEventListener('pagehide', () => { void flushSaves(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flushSaves();
  });
}

async function main() {
  try {
    initEditor();
    wireButtons();
    await openDatabase();
    const settings = await loadSettings();
    if (settings) {
      state.pinned = settings.pinned !== false;
      state.collapsed = settings.collapsed === true;
      if (typeof settings.activeId === 'string') localStorage.setItem('mini_notes_active', settings.activeId);
    }
    renderSidebar();
    renderPin();
    state.notes = await allNotes();
    if (!state.notes.length) {
      const note = createNote('我的第一篇筆記', firstContent());
      state.notes = [note];
      await saveNote(note);
    }
    const remembered = localStorage.getItem('mini_notes_active');
    const initial = state.notes.find((note) => note.id === remembered)?.id ?? state.notes[0].id;
    await selectNote(initial);
    await updatePin(state.pinned);
    if (getRecoveryMessages().length) setStatus('已從備份/暫存檔復原筆記，請先備份 data 資料夾');
    if (!inTauri) setStatus('瀏覽器預覽模式 · 置頂功能只在桌面程式生效');
  } catch (error) {
    console.error(error);
    setStatus(`初始化失敗：${errorText(error)}`, true);
  }
}

void main();
