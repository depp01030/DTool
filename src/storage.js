import { BaseDirectory, copyFile, exists, mkdir, readDir, readFile, readTextFile, remove, rename, writeFile, writeTextFile } from '@tauri-apps/plugin-fs';

const inTauri = typeof window.__TAURI_INTERNALS__ !== 'undefined';
const baseDir = BaseDirectory.AppData;
const options = { baseDir };
const DB_NAME = 'mini_notes_v1';
const DB_VERSION = 1;
const FILE_ID = /^[a-zA-Z0-9_-]{1,90}$/;
const IMAGE_KEY = /^images\/[a-f0-9-]{36}\.(png|jpg|webp|gif|svg)$/;
let cachedDb;
let folderReady;
const imageCache = new Map();
const mimeTypes = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml' };

async function ensureFolders() {
  if (!inTauri) return;
  if (!folderReady) {
    folderReady = (async () => {
      await mkdir('notes', { ...options, recursive: true });
      await mkdir('images', { ...options, recursive: true });
    })().catch((error) => { folderReady = null; throw error; });
  }
  await folderReady;
}

async function visitNodes(node, visitor) {
  if (!node || typeof node !== 'object') return;
  await visitor(node);
  for (const child of node.content ?? []) await visitNodes(child, visitor);
}

function imageExtension(dataUrl) {
  const match = /^data:image\/(png|jpeg|jpg|webp|gif|svg\+xml);base64,/.exec(dataUrl);
  if (!match) throw new Error('不支援的圖片格式');
  return { jpeg: 'jpg', 'svg+xml': 'svg' }[match[1]] ?? match[1];
}

async function asDataUrl(bytes, mime) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('無法讀取圖片'));
    reader.readAsDataURL(new Blob([bytes], { type: mime }));
  });
}

export async function storeImage(dataUrl) {
  if (!inTauri) return null;
  await ensureFolders();
  const extension = imageExtension(dataUrl);
  const key = `images/${crypto.randomUUID()}.${extension}`;
  const bytes = new Uint8Array(await (await fetch(dataUrl)).arrayBuffer());
  await writeFile(key, bytes, options);
  imageCache.set(key, dataUrl);
  return key;
}

async function readImage(key) {
  if (!IMAGE_KEY.test(key)) throw new Error('Invalid image path');
  if (!imageCache.has(key)) {
    const bytes = await readFile(key, options);
    const extension = key.split('.').pop();
    imageCache.set(key, await asDataUrl(bytes, mimeTypes[extension]));
  }
  return imageCache.get(key);
}

export async function hydrateNote(note) {
  if (!inTauri) return note;
  await visitNodes(note.content, async (node) => {
    if (node.type !== 'image' || !node.attrs) return;
    const attrs = node.attrs;
    const key = attrs.storageKey || (IMAGE_KEY.test(attrs.src ?? '') ? attrs.src : null);
    if (key) {
      attrs.storageKey = key;
      attrs.src = await readImage(key);
    } else if (typeof attrs.src === 'string' && attrs.src.startsWith('data:image/')) {
      attrs.storageKey = await storeImage(attrs.src);
    }
  });
  return note;
}

function validateId(id) {
  if (typeof id !== 'string' || !FILE_ID.test(id)) throw new Error('Invalid note ID');
  return id;
}

async function portableSave(note) {
  await ensureFolders();
  const id = validateId(note.id);
  const saved = structuredClone(note);
  await visitNodes(saved.content, async (node) => {
    if (node.type !== 'image' || !node.attrs) return;
    const attrs = node.attrs;
    if (!attrs.storageKey && typeof attrs.src === 'string' && attrs.src.startsWith('data:image/')) {
      attrs.storageKey = await storeImage(attrs.src);
    }
    if (attrs.storageKey) {
      if (!IMAGE_KEY.test(attrs.storageKey)) throw new Error('Invalid image key');
      attrs.src = attrs.storageKey;
    }
  });
  const path = `notes/${id}.json`;
  const temporary = `${path}.tmp`;
  await writeTextFile(temporary, JSON.stringify(saved, null, 2), options);
  if (await exists(path, options)) {
    // Keep a previous generation as a recovery point until replacement succeeds.
    await copyFile(path, `${path}.bak`, { fromPathBaseDir: baseDir, toPathBaseDir: baseDir });
  }
  // rename() accepts oldPathBaseDir/newPathBaseDir, NOT copyFile's options.
  // Do not remove the old JSON first. If rename fails, both it and .tmp remain.
  await rename(temporary, path, { oldPathBaseDir: baseDir, newPathBaseDir: baseDir });
}

const recoveryMessages = [];
export function getRecoveryMessages() {
  return [...recoveryMessages];
}

async function portableNotes() {
  await ensureFolders();
  recoveryMessages.length = 0;
  const grouped = new Map();
  const filePattern = /^([a-zA-Z0-9_-]{1,90})\.json(\.tmp|\.bak)?$/;

  for (const entry of await readDir('notes', options)) {
    if (!entry.isFile) continue;
    const match = filePattern.exec(entry.name);
    if (!match) continue;
    if (!grouped.has(match[1])) grouped.set(match[1], new Set());
    grouped.get(match[1]).add(entry.name);
  }

  const results = [];
  for (const [id, names] of grouped) {
    // v0.2.0 used the wrong rename() base directory options. Its pending
    // notes may remain in .json.tmp with no .json at all.
    const candidates = [];
    const errors = [];
    for (const [suffix, priority] of [['.json', 0], ['.json.tmp', 1], ['.json.bak', 2]]) {
      const name = id + suffix;
      if (!names.has(name)) continue;
      try {
        const json = JSON.parse(await readTextFile('notes/' + name, options));
        if (!json || json.id !== id || !json.content || json.content.type !== 'doc') {
          throw new Error('Invalid note ID or editor content');
        }
        candidates.push({ name, json, priority, updatedAt: Number(json.updatedAt) || 0 });
      } catch (error) {
        errors.push(name + ': ' + String(error));
      }
    }

    if (!candidates.length) {
      // Never overwrite or discard files that we cannot read.
      throw new Error('筆記 ' + id + ' 無法讀取。請備份 data/notes：' + errors.join('；'));
    }

    candidates.sort((a, b) => b.updatedAt - a.updatedAt || a.priority - b.priority);
    const chosen = candidates[0];
    if (chosen.name !== id + '.json') {
      const message = '筆記 ' + id + ' 已從 ' + chosen.name + ' 復原（原始檔案保留）';
      console.warn(message);
      recoveryMessages.push(message);
    }
    if (errors.length) console.warn('Ignored corrupt note versions:', errors);
    results.push(await hydrateNote(chosen.json));
  }
  return results;
}

export async function openDatabase() {
  if (inTauri) return ensureFolders();
  if (cachedDb) return cachedDb;
  cachedDb = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('notes')) db.createObjectStore('notes', { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return cachedDb;
}

async function legacyNotes() {
  if (!cachedDb) {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    cachedDb = new Promise((resolve, reject) => {
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('notes')) request.result.createObjectStore('notes', { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  const db = await cachedDb;
  return new Promise((resolve, reject) => {
    const request = db.transaction('notes', 'readonly').objectStore('notes').getAll();
    request.onsuccess = () => resolve(request.result ?? []);
    request.onerror = () => reject(request.error);
  });
}

export async function allNotes() {
  if (!inTauri) {
    await openDatabase();
    return legacyNotes();
  }
  const notes = await portableNotes();
  if (notes.length) return notes;
  // Import legacy IndexedDB only when it is present in the same WebView profile.
  // The portable build deliberately uses a new profile in ./data.
  const previous = await legacyNotes();
  for (const note of previous) {
    await hydrateNote(note);
    await portableSave(note);
  }
  return previous;
}

export async function saveNote(note) {
  if (inTauri) return portableSave(note);
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('notes', 'readwrite');
    tx.objectStore('notes').put(note);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function deleteNote(id) {
  if (inTauri) {
    await ensureFolders();
    const path = `notes/${validateId(id)}.json`;
    if (await exists(path, options)) await remove(path, options);
    const backup = `${path}.bak`;
    if (await exists(backup, options)) await remove(backup, options);
    return;
  }
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('notes', 'readwrite');
    tx.objectStore('notes').delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function loadSettings() {
  if (!inTauri) return null;
  await ensureFolders();
  if (!(await exists('settings.json', options))) return null;
  return JSON.parse(await readTextFile('settings.json', options));
}

export async function saveSettings(settings) {
  if (!inTauri) return;
  await ensureFolders();
  await writeTextFile('settings.json', JSON.stringify(settings, null, 2), options);
}
