import { readFile, BaseDirectory } from '@tauri-apps/plugin-fs';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import './viewer.css';

const keyPattern = /^images\/[a-f0-9-]{36}\.(png|jpg|webp|gif|svg)$/;
const mime = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml' };
const viewport = document.getElementById('viewport');
const photo = document.getElementById('full-image');
const status = document.getElementById('viewer-status');
const size = document.getElementById('image-size');
const percent = document.getElementById('zoom-percent');
let zoom = 1;
let panX = 0;
let panY = 0;
let fitMode = true;
let currentURL = null;
let requestId = 0;
let drag = null;

function applyTransform() {
  photo.style.transform = 'translate(-50%, -50%) translate(' + panX + 'px, ' + panY + 'px) scale(' + zoom + ')';
  percent.textContent = Math.round(zoom * 100) + '%';
  viewport.classList.toggle('can-pan', zoom > 0);
}

function fit() {
  if (!photo.naturalWidth) return;
  fitMode = true;
  const w = Math.max(1, viewport.clientWidth - 44);
  const h = Math.max(1, viewport.clientHeight - 44);
  zoom = Math.min(1, w / photo.naturalWidth, h / photo.naturalHeight);
  panX = 0;
  panY = 0;
  applyTransform();
}

function setZoom(next, anchorX = 0, anchorY = 0) {
  if (!photo.naturalWidth) return;
  const previous = zoom;
  zoom = Math.min(8, Math.max(0.05, next));
  const ratio = zoom / previous;
  panX = anchorX - (anchorX - panX) * ratio;
  panY = anchorY - (anchorY - panY) * ratio;
  fitMode = false;
  applyTransform();
}

function originalSize() {
  fitMode = false;
  zoom = 1;
  panX = 0;
  panY = 0;
  applyTransform();
}

function showStatus(text) {
  status.textContent = text;
  status.hidden = false;
}
async function loadImage(key) {
  const id = ++requestId;
  if (typeof key !== 'string' || !keyPattern.test(key)) {
    showStatus('圖片路徑無效');
    return;
  }
  showStatus('正在讀取原始圖片…');
  try {
    const bytes = await readFile(key, { baseDir: BaseDirectory.AppData });
    if (id !== requestId) return;
    const ext = key.split('.').pop();
    const url = URL.createObjectURL(new Blob([bytes], { type: mime[ext] }));
    photo.onload = () => {
      if (id !== requestId) { URL.revokeObjectURL(url); return; }
      if (currentURL) URL.revokeObjectURL(currentURL);
      currentURL = url;
      photo.style.width = photo.naturalWidth + 'px';
      photo.style.height = photo.naturalHeight + 'px';
      size.textContent = photo.naturalWidth + ' × ' + photo.naturalHeight + ' px';
      photo.hidden = false;
      status.hidden = true;
      fit();
    };
    photo.onerror = () => {
      URL.revokeObjectURL(url);
      showStatus('圖片解碼失敗');
    };
    photo.src = url;
  } catch (error) {
    if (id === requestId) showStatus('讀取圖片失敗：' + (error?.message || String(error)));
  }
}

viewport.addEventListener('wheel', (event) => {
  event.preventDefault();
  if (!photo.naturalWidth) return;
  const rect = viewport.getBoundingClientRect();
  const mx = event.clientX - rect.left - rect.width / 2;
  const my = event.clientY - rect.top - rect.height / 2;
  setZoom(zoom * (event.deltaY < 0 ? 1.15 : 1 / 1.15), mx, my);
}, { passive: false });

viewport.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || !photo.naturalWidth) return;
  drag = { x: event.clientX, y: event.clientY, panX, panY };
  viewport.setPointerCapture(event.pointerId);
  viewport.classList.add('dragging');
});
viewport.addEventListener('pointermove', (event) => {
  if (!drag) return;
  panX = drag.panX + event.clientX - drag.x;
  panY = drag.panY + event.clientY - drag.y;
  fitMode = false;
  applyTransform();
});
function stopDrag() {
  drag = null;
  viewport.classList.remove('dragging');
}
viewport.addEventListener('pointerup', stopDrag);
viewport.addEventListener('pointercancel', stopDrag);
viewport.addEventListener('lostpointercapture', stopDrag);
document.getElementById('zoom-out').addEventListener('click', () => setZoom(zoom / 1.25));
document.getElementById('zoom-in').addEventListener('click', () => setZoom(zoom * 1.25));
document.getElementById('zoom-fit').addEventListener('click', fit);
document.getElementById('zoom-original').addEventListener('click', originalSize);
document.getElementById('close-viewer').addEventListener('click', () => { void getCurrentWindow().close(); });
window.addEventListener('resize', () => { if (fitMode) fit(); });
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') void getCurrentWindow().close();
  if (event.key.toLowerCase() === 'f') fit();
  if (event.key === '0') originalSize();
  if (event.key === '+' || event.key === '=') setZoom(zoom * 1.25);
  if (event.key === '-') setZoom(zoom / 1.25);
});
window.addEventListener('pagehide', () => { if (currentURL) URL.revokeObjectURL(currentURL); });

async function main() {
  await listen('mini-notes:show-image', (event) => { void loadImage(event.payload?.key); });
  const requested = new URLSearchParams(location.search).get('image');
  void loadImage(requested);
}
void main().catch(error => showStatus('初始化圖片檢視器失敗：' + error.message));
