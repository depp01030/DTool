import { Editor, Extension } from '@tiptap/core';
import { StarterKit } from '@tiptap/starter-kit';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { Image } from '@tiptap/extension-image';
import { Placeholder } from '@tiptap/extension-placeholder';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { allNotes, deleteNote, openDatabase, saveNote, storeImage, loadSettings, saveSettings } from './storage';
import './style.css';

const $ = (selector) => document.querySelector(selector);
const inTauri = typeof window.__TAURI_INTERNALS__ !== 'undefined';
const pending = new Map();
const writeQueues = new Map();
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
        { type: 'taskItem', attrs: { checked: false }, content: [{ type: 'paragraph', content: [{ type: 'text', text: '用 Ctrl+V 貼上圖片，也可以拖曳圖片到筆記裡' }] }] },
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

function setStatus(message, error = false) {
  const element = $('#save-status');
  element.textContent = message;
  element.classList.toggle('error', error);
}

async function writeNote(note) {
  try {
    // Serialize by note ID so older writes cannot overwrite newer edits.
    const snapshot = structuredClone(note);
    const previous = writeQueues.get(note.id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => saveNote(snapshot));
    writeQueues.set(note.id, next);
    try { await next; } finally { if (writeQueues.get(note.id) === next) writeQueues.delete(note.id); }
    if (note.id === state.activeId) setStatus('✓ 已自動儲存');
  } catch (error) {
    console.error('Save failed:', error);
    setStatus('儲存失敗：請檢查本機磁碟空間', true);
  }
}

function scheduleSave(note) {
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
  if (!note) return;
  if (!window.confirm(`確定刪除「${note.title || '無標題筆記'}」？此操作無法復原。`)) return;
  const timer = pending.get(note.id);
  if (timer) clearTimeout(timer);
  pending.delete(note.id);
  state.notes = state.notes.filter((item) => item.id !== note.id);
  await deleteNote(note.id);
  if (state.notes.length === 0) {
    const replacement = createNote();
    state.notes.push(replacement);
    await saveNote(replacement);
  }
  const next = [...state.notes].sort((a, b) => b.updatedAt - a.updatedAt)[0];
  state.activeId = null;
  await selectNote(next.id);
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
  if (file.size > 18 * 1024 * 1024) throw new Error('單張圖片限制 18MB');
  const source = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('無法讀取圖片'));
    reader.readAsDataURL(file);
  });
  if (file.type === 'image/gif' || file.type === 'image/svg+xml') return source;
  // Convert large screen captures to WebP to reduce saved note size.
  try {
    const bitmap = await createImageBitmap(file);
    const maxEdge = 1600;
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const converted = canvas.toDataURL('image/webp', 0.88);
    return converted.startsWith('data:image/webp') ? converted : source;
  } catch {
    return source;
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
    if (!inTauri) setStatus('瀏覽器預覽模式 · 置頂功能只在桌面程式生效');
  } catch (error) {
    console.error(error);
    setStatus(`初始化失敗：${error.message}`, true);
  }
}

void main();
