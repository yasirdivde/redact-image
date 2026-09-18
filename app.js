/* ============================================================
   Redact - Image — private screenshot redaction
   All processing happens locally. No network calls.
   ============================================================ */
(() => {
  'use strict';

  /* ---------------- Element refs ---------------- */
  const landingView = document.getElementById('landingView');
  const appView     = document.getElementById('appView');
  const resultView  = document.getElementById('resultView');
  const canvas      = document.getElementById('canvas');
  const ctx         = canvas.getContext('2d');
  const canvasWrap  = document.getElementById('canvasWrap');
  const emptyState  = document.getElementById('emptyState');
  const dropZone    = document.getElementById('dropZone');
  const fileInput   = document.getElementById('fileInput');
  const btnChoose   = document.getElementById('btnChoose');
  const btnNew      = document.getElementById('btnNew');
  const btnHome     = document.getElementById('btnHome');
  const btnDone     = document.getElementById('btnDone');
  const btnZoom     = document.getElementById('btnZoom');
  const zoomControls = document.getElementById('zoomControls');
  const landingDropZone = document.getElementById('landingDropZone');

  const resultImg          = document.getElementById('resultImg');
  const filenameInput      = document.getElementById('filenameInput');
  const filenameExt        = document.getElementById('filenameExt');
  const resultFormat       = document.getElementById('resultFormat');
  const resultQuality      = document.getElementById('resultQuality');
  const resultQualityVal   = document.getElementById('resultQualityValue');
  const resultQualityGroup = document.getElementById('resultQualityGroup');
  const resultFilesize     = document.getElementById('resultFilesize');
  const btnResultDownload  = document.getElementById('btnResultDownload');
  const btnResultCopy      = document.getElementById('btnResultCopy');

  const lightbox      = document.getElementById('lightbox');
  const lightboxImg   = document.getElementById('lightboxImg');
  const lightboxClose = document.getElementById('lightboxClose');

  const q    = (sel) => document.querySelector(sel);
  const qAll = (sel) => Array.from(document.querySelectorAll(sel));

  /* ---------------- Constants ---------------- */
  const NOISE_AMPLITUDE        = 5;
  const EXPORT_EXTRA_NOISE     = 5;
  const BLUR_SAFE_MIN          = 12;
  const MOSAIC_SAFE_MIN        = 10;

  /* ---------------- State ---------------- */
  const state = {
    hasImage: false,
    tool: null,
    brushSize: 20,
    blurStrength: 8,
    mosaicSize: 12,
    color: '#000000',
    format: 'image/png',
    quality: 0.92,

    drawing: false,
    pickingColor: false,
    strokeScale: 1,
    strokeEffect: null,
    snapshotBefore: null,
    startPoint: null,
    lastPoint: null,

    history: [],
    historyIndex: -1,
    maxHistory: 25,
  };

  const zoom = {
    active: false,
    scale: 1,
    tx: 0,
    ty: 0,
    pointers: new Map(),
    isPanning: false,
    panStart: { x: 0, y: 0 },
    pinch: null,
    min: 1,
    max: 8,
  };

  let historyChain = Promise.resolve();
  let restoreToken = 0;
  let cachedRect = null;
  let resultImgUrl = null;

  let previewRAF = null;
  let previewHideTimer = null;
  let sizeComputeToken = 0;

  let sizeProxyCanvas = null;
  const sizeCache = new Map();

  /* ---------------- Gradient ring style injection ---------------- */
  (function injectRingStyles() {
    const style = document.createElement('style');
    style.textContent = `
      .gradient-ring {
        border: none !important;
        background: linear-gradient(135deg, #ec4899 0%, #a855f7 50%, #6366f1 100%) !important;
        -webkit-mask: radial-gradient(circle closest-side, transparent calc(100% - 3px), #000 calc(100% - 3px));
                mask: radial-gradient(circle closest-side, transparent calc(100% - 3px), #000 calc(100% - 3px));
        border-radius: 50% !important;
        box-shadow: none !important;
      }
    `;
    document.head.appendChild(style);
  })();

  /* ---------------- Cursor ring ---------------- */
  const cursorRing = document.createElement('div');
  cursorRing.className = 'gradient-ring absolute pointer-events-none z-10';
  cursorRing.style.transform = 'translate(-50%, -50%)';
  cursorRing.style.display = 'none';
  canvas.parentElement.appendChild(cursorRing);

  /* ---------------- Effect preview circle ---------------- */
  const previewEl = document.createElement('div');
  previewEl.className =
    'pointer-events-none absolute hidden z-30 rounded-full overflow-hidden shadow-2xl';
  previewEl.style.transform = 'translate(-50%, -50%)';
  const previewCanvas = document.createElement('canvas');
  previewCanvas.style.width = '100%';
  previewCanvas.style.height = '100%';
  previewCanvas.style.display = 'block';
  previewEl.appendChild(previewCanvas);
  canvas.parentElement.appendChild(previewEl);

  /* ============================================================
     Visual scale helper
     ------------------------------------------------
     Canvas pixels per screen pixel, accounting for any CSS
     transform (zoom + pan). Recomputes from getBoundingClientRect
     so it is always in sync with the current rendered size.
     ============================================================ */
  function getVisualScale() {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width) return 1;
    return canvas.width / rect.width;
  }

  /* ============================================================
     View switching
     ============================================================ */
  function showLanding() {
    closeLightbox();
    landingView.classList.remove('hidden');
    appView.classList.add('hidden');
    appView.classList.remove('flex');
    resultView.classList.add('hidden');
    resultView.classList.remove('flex');
    window.scrollTo(0, 0);
    requestAnimationFrame(refreshIcons);
  }

  function showApp() {
    closeLightbox();
    landingView.classList.add('hidden');
    resultView.classList.add('hidden');
    resultView.classList.remove('flex');
    appView.classList.remove('hidden');
    appView.classList.add('flex');
    window.scrollTo(0, 0);
    requestAnimationFrame(() => {
      refreshIcons();
      fitCanvasToViewport();
    });
  }

  function showResult() {
    if (!state.hasImage) return;

    try {
      resultImg.src = canvas.toDataURL('image/png');
    } catch (_) {
      canvas.toBlob((blob) => {
        if (!blob) return;
        if (resultImgUrl) URL.revokeObjectURL(resultImgUrl);
        resultImgUrl = URL.createObjectURL(blob);
        resultImg.src = resultImgUrl;
      }, 'image/png');
    }

    if (!filenameInput.value) filenameInput.value = defaultFilename();
    updateResultFilenameExt();
    updateResultSize();

    closeLightbox();
    landingView.classList.add('hidden');
    appView.classList.add('hidden');
    appView.classList.remove('flex');
    resultView.classList.remove('hidden');
    resultView.classList.add('flex');
    window.scrollTo(0, 0);
    requestAnimationFrame(refreshIcons);
  }

  btnHome.addEventListener('click', () => {
    if (state.hasImage && !confirm('Return to home? Your current image will be lost.')) return;
    showLanding();
  });

  q('#btnResultHome').addEventListener('click', showLanding);
  q('#btnResultHome2').addEventListener('click', showLanding);
  q('#btnResultBack').addEventListener('click', showApp);
  q('#btnResultBack2').addEventListener('click', showApp);

  btnNew.addEventListener('click', () => fileInput.click());
  btnDone.addEventListener('click', showResult);

  /* ============================================================
     Helpers
     ============================================================ */
  function getCanvasPoint(e) {
    const rect = cachedRect || canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (canvas.width / rect.width),
      y: (e.clientY - rect.top) * (canvas.height / rect.height),
    };
  }

  function getCanvasPointFromScreen(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return { x: 0, y: 0 };
    const fx = (clientX - rect.left) / rect.width;
    const fy = (clientY - rect.top)  / rect.height;
    return {
      x: Math.max(0, Math.min(1, fx)) * canvas.width,
      y: Math.max(0, Math.min(1, fy)) * canvas.height,
    };
  }

  function formatBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  function refreshIcons() {
    if (window.lucide && typeof window.lucide.createIcons === 'function') {
      window.lucide.createIcons();
    }
  }

  function flashButton(btn, msg, iconName) {
    const orig = btn.innerHTML;
    btn.innerHTML = '<i data-lucide="' + iconName + '" class="w-4 h-4"></i> ' + msg;
    refreshIcons();
    setTimeout(() => { btn.innerHTML = orig; refreshIcons(); }, 1600);
  }

  function showToast(msg, ms = 2400) {
    let el = document.getElementById('redact-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'redact-toast';
      el.className =
        'fixed bottom-24 sm:bottom-8 left-1/2 -translate-x-1/2 z-[90] ' +
        'bg-white text-neutral-900 text-sm font-semibold px-4 py-2.5 rounded-lg ' +
        'shadow-xl transition-opacity duration-200 pointer-events-none ' +
        'max-w-[90vw] text-center';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.opacity = '1';
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => { el.style.opacity = '0'; }, ms);
  }

  function defaultFilename() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `redact-image-${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  }

  /* ============================================================
     Effect size helpers (canvas pixels)
     ------------------------------------------------
     Sized relative to the *visual* brush footprint, so the effect
     proportion stays the same at any zoom or image resolution.
     ============================================================ */
  function effectBlurCanvasPx(scale) {
    return Math.max(1, state.blurStrength * scale);
  }
  function effectMosaicCanvasPx(scale) {
    return Math.max(2, state.mosaicSize * scale);
  }

  /* ============================================================
     Destructive noise layer
     ============================================================ */
  function addNoise(targetCanvas, amplitude) {
    const w = targetCanvas.width;
    const h = targetCanvas.height;
    if (w < 1 || h < 1) return;

    const tctx = targetCanvas.getContext('2d');
    let img;
    try {
      img = tctx.getImageData(0, 0, w, h);
    } catch (_) {
      return;
    }
    const data = img.data;
    const amp = amplitude;

    for (let i = 0; i < data.length; i += 4) {
      let r = data[i]     + (Math.random() * 2 - 1) * amp;
      let g = data[i + 1] + (Math.random() * 2 - 1) * amp;
      let b = data[i + 2] + (Math.random() * 2 - 1) * amp;
      data[i]     = r < 0 ? 0 : r > 255 ? 255 : r;
      data[i + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
      data[i + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
    }
    tctx.putImageData(img, 0, 0);
  }

  /* ============================================================
     Warning line updates
     ============================================================ */
  function updateWarnings() {
    const blurRisky   = state.tool === 'blur'   && state.blurStrength < BLUR_SAFE_MIN;
    const mosaicRisky = state.tool === 'mosaic' && state.mosaicSize   < MOSAIC_SAFE_MIN;
    qAll('[data-blur-warning]').forEach((el)   => el.classList.toggle('hidden', !blurRisky));
    qAll('[data-mosaic-warning]').forEach((el) => el.classList.toggle('hidden', !mosaicRisky));
  }

  /* ============================================================
     Size estimation (cached proxy + per-format cache)
     ============================================================ */
  function invalidateSizeCache() {
    sizeCache.clear();
    sizeProxyCanvas = null;
  }

  function getSizeProxy() {
    if (sizeProxyCanvas) return sizeProxyCanvas;
    const sw = canvas.width, sh = canvas.height;
    if (!sw || !sh) return null;
    const PROXY_MAX = 320;
    const scale = Math.min(1, PROXY_MAX / Math.max(sw, sh));
    if (scale >= 1) return null;
    const pw = Math.max(1, Math.round(sw * scale));
    const ph = Math.max(1, Math.round(sh * scale));
    const p = document.createElement('canvas');
    p.width = pw; p.height = ph;
    const pctx = p.getContext('2d');
    pctx.imageSmoothingEnabled = true;
    pctx.imageSmoothingQuality = 'high';
    pctx.drawImage(canvas, 0, 0, sw, sh, 0, 0, pw, ph);
    sizeProxyCanvas = p;
    return p;
  }

  function estimateBlobSize(format, quality) {
    return new Promise((resolve) => {
      const key = format + '|' + quality.toFixed(3);
      if (sizeCache.has(key)) { resolve(sizeCache.get(key)); return; }

      const proxy = getSizeProxy();
      const source = proxy || canvas;
      const sw = canvas.width, sh = canvas.height;
      const pw = source.width, ph = source.height;

      source.toBlob((blob) => {
        if (!blob) { resolve(null); return; }
        let est;
        if (pw === sw && ph === sh) {
          est = blob.size;
        } else {
          const ratio = (sw * sh) / (pw * ph);
          const exp = format === 'image/png' ? 1.0 : 0.82;
          est = Math.max(1, Math.round(blob.size * Math.pow(ratio, exp)));
        }
        sizeCache.set(key, est);
        resolve(est);
      }, format, quality);
    });
  }

  function updateResultSize() {
    if (!state.hasImage) { resultFilesize.textContent = '—'; return; }

    const myToken = ++sizeComputeToken;
    const key = state.format + '|' + state.quality.toFixed(3);

    if (sizeCache.has(key)) {
      resultFilesize.textContent = '≈ ' + formatBytes(sizeCache.get(key));
      return;
    }

    resultFilesize.textContent = '…';

    estimateBlobSize(state.format, state.quality).then((bytes) => {
      if (myToken !== sizeComputeToken) return;
      resultFilesize.textContent = bytes != null ? '≈ ' + formatBytes(bytes) : '—';
    });
  }

  /* ============================================================
     Export-time hardening
     ============================================================ */
  function makeExportCanvas() {
    if (state.format === 'image/png') return canvas;
    const out = document.createElement('canvas');
    out.width = canvas.width;
    out.height = canvas.height;
    const octx = out.getContext('2d');
    octx.drawImage(canvas, 0, 0);
    addNoise(out, EXPORT_EXTRA_NOISE);
    return out;
  }

  /* ============================================================
     Fit canvas to viewport
     ============================================================ */
  function fitCanvasToViewport() {
    if (!state.hasImage) return;
    if (!canvasWrap || canvasWrap.classList.contains('hidden')) return;

    const wrapRect = canvasWrap.getBoundingClientRect();
    if (!wrapRect.width || !wrapRect.height) return;

    const isDesktop = window.matchMedia('(min-width: 640px)').matches;
    const pad = (isDesktop ? 24 : 12) * 2 + 8;

    const availW = Math.max(40, wrapRect.width - pad);
    const availH = Math.max(40, wrapRect.height - pad);

    const ratio = canvas.width / canvas.height;
    let dw, dh;
    if (availW / availH > ratio) {
      dh = availH;
      dw = dh * ratio;
    } else {
      dw = availW;
      dh = dw / ratio;
    }

    canvas.style.width  = Math.max(1, Math.round(dw)) + 'px';
    canvas.style.height = Math.max(1, Math.round(dh)) + 'px';
    cachedRect = null;
  }

  if (window.ResizeObserver) {
    const ro = new ResizeObserver(() => {
      if (fitCanvasToViewport._pending) return;
      fitCanvasToViewport._pending = true;
      requestAnimationFrame(() => {
        fitCanvasToViewport._pending = false;
        fitCanvasToViewport();
      });
    });
    ro.observe(canvasWrap);
    ro.observe(document.body);
  }

  window.addEventListener('resize', fitCanvasToViewport);
  window.addEventListener('orientationchange', () => setTimeout(fitCanvasToViewport, 120));

  /* ============================================================
     Image loading
     ============================================================ */
  function loadImageFile(file) {
    if (!file || !file.type || !file.type.startsWith('image/')) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      initCanvas(img);
    };
    img.onerror = () => { URL.revokeObjectURL(url); alert('Could not load that image.'); };
    img.src = url;
  }

  function initCanvas(img) {
    const MAX = 4096;
    let w = img.naturalWidth;
    let h = img.naturalHeight;
    if (!w || !h) return;

    const scale = Math.min(1, MAX / Math.max(w, h));
    w = Math.max(1, Math.round(w * scale));
    h = Math.max(1, Math.round(h * scale));

    canvas.width = w;
    canvas.height = h;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);

    historyChain = Promise.resolve();
    restoreToken = 0;
    state.history = [];
    state.historyIndex = -1;
    invalidateSizeCache();

    zoom.scale = 1; zoom.tx = 0; zoom.ty = 0;
    applyZoom();
    updateZoomUI();

    setHasImage(true);

    if (appView.classList.contains('hidden')) {
      showApp();
    }

    requestAnimationFrame(fitCanvasToViewport);
    pushHistory();
  }

  function setHasImage(v) {
    state.hasImage = v;
    emptyState.classList.toggle('hidden', v);
    canvasWrap.classList.toggle('hidden', !v);
    btnDone.disabled = !v;
    btnZoom.disabled = !v;
    updateHistoryButtons();
    updateZoomUI();
  }

  /* ============================================================
     History
     ============================================================ */
  function updateHistoryButtons() {
    const none = !state.hasImage;
    const undoDisabled = none || state.historyIndex <= 0;
    const redoDisabled = none || state.historyIndex >= state.history.length - 1;
    qAll('[data-undo]').forEach((b) => (b.disabled = undoDisabled));
    qAll('[data-redo]').forEach((b) => (b.disabled = redoDisabled));
    qAll('[data-reset]').forEach((b) => (b.disabled = none));
  }

  function pushHistory() {
    if (!state.hasImage) return;

    invalidateSizeCache();

    const snap = document.createElement('canvas');
    snap.width = canvas.width;
    snap.height = canvas.height;
    snap.getContext('2d').drawImage(canvas, 0, 0);

    state.history = state.history.slice(0, state.historyIndex + 1);
    state.history.push(null);
    if (state.history.length > state.maxHistory) state.history.shift();
    const myIndex = state.history.length - 1;
    state.historyIndex = myIndex;
    updateHistoryButtons();

    historyChain = historyChain.then(() =>
      new Promise((resolve) => {
        snap.toBlob((blob) => {
          if (blob) state.history[myIndex] = blob;
          updateHistoryButtons();
          resolve();
        }, 'image/png');
      })
    );
  }

  function restoreFromHistory(index) {
    const blob = state.history[index];
    if (!blob) return;
    const myToken = ++restoreToken;
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      if (myToken !== restoreToken) { URL.revokeObjectURL(url); return; }
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
    };
    img.onerror = () => URL.revokeObjectURL(url);
    img.src = url;
  }

  function undo() {
    if (!state.hasImage) return;
    historyChain = historyChain.then(() => {
      if (state.historyIndex <= 0) return;
      state.historyIndex--;
      restoreFromHistory(state.historyIndex);
      updateHistoryButtons();
    });
  }

  function redo() {
    if (!state.hasImage) return;
    historyChain = historyChain.then(() => {
      if (state.historyIndex >= state.history.length - 1) return;
      state.historyIndex++;
      restoreFromHistory(state.historyIndex);
      updateHistoryButtons();
    });
  }

  /* ============================================================
     Effects — destructive by default
     ============================================================ */
  function makeBlurred(srcCanvas, blurPx) {
    const w = srcCanvas.width, h = srcCanvas.height;
    if (w < 1 || h < 1) return null;

    const P = Math.max(1, Math.ceil(blurPx * 2));
    const pw = w + 2 * P, ph = h + 2 * P;

    const pad = document.createElement('canvas');
    pad.width = pw; pad.height = ph;
    const pctx = pad.getContext('2d');
    pctx.drawImage(srcCanvas, P, P, w, h);
    pctx.drawImage(srcCanvas, 0, 0, w, 1, P, 0, w, P);
    pctx.drawImage(srcCanvas, 0, h - 1, w, 1, P, h + P, w, P);
    pctx.drawImage(srcCanvas, 0, 0, 1, h, 0, P, P, h);
    pctx.drawImage(srcCanvas, w - 1, 0, 1, h, w + P, P, P, h);
    pctx.drawImage(srcCanvas, 0, 0, 1, 1, 0, 0, P, P);
    pctx.drawImage(srcCanvas, w - 1, 0, 1, 1, w + P, 0, P, P);
    pctx.drawImage(srcCanvas, 0, h - 1, 1, 1, 0, h + P, P, P);
    pctx.drawImage(srcCanvas, w - 1, h - 1, 1, 1, w + P, h + P, P, P);

    const k = Math.max(1, blurPx);
    const sw = Math.max(1, Math.round(pw / k));
    const sh = Math.max(1, Math.round(ph / k));
    const small = document.createElement('canvas');
    small.width = sw; small.height = sh;
    const sctx = small.getContext('2d');
    sctx.imageSmoothingEnabled = true;
    sctx.imageSmoothingQuality = 'high';
    sctx.drawImage(pad, 0, 0, pw, ph, 0, 0, sw, sh);

    const eff = document.createElement('canvas');
    eff.width = w; eff.height = h;
    const ectx = eff.getContext('2d');
    ectx.imageSmoothingEnabled = true;
    ectx.imageSmoothingQuality = 'high';
    ectx.drawImage(small, 0, 0, sw, sh, -P, -P, pw, ph);

    addNoise(eff, NOISE_AMPLITUDE);

    return eff;
  }

  function makePixelated(srcCanvas, cell) {
    const w = srcCanvas.width, h = srcCanvas.height;
    if (w < 1 || h < 1) return null;

    cell = Math.max(2, cell);
    const sw = Math.max(1, Math.round(w / cell));
    const sh = Math.max(1, Math.round(h / cell));

    const small = document.createElement('canvas');
    small.width = sw; small.height = sh;
    const sctx = small.getContext('2d');
    sctx.imageSmoothingEnabled = true;
    sctx.imageSmoothingQuality = 'high';
    sctx.drawImage(srcCanvas, 0, 0, w, h, 0, 0, sw, sh);

    const eff = document.createElement('canvas');
    eff.width = w; eff.height = h;
    const ectx = eff.getContext('2d');
    ectx.imageSmoothingEnabled = false;
    ectx.drawImage(small, 0, 0, sw, sh, 0, 0, w, h);

    addNoise(eff, NOISE_AMPLITUDE);

    return eff;
  }

  /* ============================================================
     Brush painting
     ============================================================ */
  function paintBrushSegment(x0, y0, x1, y1, r) {
    const eff = state.strokeEffect;
    if (!eff || r <= 0) return;

    const dx = x1 - x0, dy = y1 - y0;
    const dist = Math.hypot(dx, dy);
    const step = Math.max(1, r / 4);
    const n = Math.max(1, Math.ceil(dist / step));

    ctx.save();
    ctx.beginPath();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const cx = x0 + dx * t, cy = y0 + dy * t;
      ctx.moveTo(cx + r, cy);
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      if (cx - r < minX) minX = cx - r;
      if (cy - r < minY) minY = cy - r;
      if (cx + r > maxX) maxX = cx + r;
      if (cy + r > maxY) maxY = cy + r;
    }
    ctx.clip();

    const sx = Math.max(0, Math.floor(minX));
    const sy = Math.max(0, Math.floor(minY));
    const ex = Math.min(canvas.width, Math.ceil(maxX));
    const ey = Math.min(canvas.height, Math.ceil(maxY));
    const bw = ex - sx, bh = ey - sy;
    if (bw > 0 && bh > 0) ctx.drawImage(eff, sx, sy, bw, bh, sx, sy, bw, bh);
    ctx.restore();
  }

  function drawSolidPreview(a, b) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(state.snapshotBefore, 0, 0);

    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    const w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
    if (w < 1 || h < 1) return;

    const s = state.strokeScale;
    ctx.save();
    ctx.globalAlpha = 0.4;
    ctx.fillStyle = state.color;
    ctx.fillRect(x, y, w, h);
    ctx.restore();

    ctx.save();
    ctx.lineWidth = Math.max(2, 3.5 * s);
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.strokeRect(x, y, w, h);
    ctx.lineWidth = Math.max(1, 1.5 * s);
    ctx.setLineDash([6 * s, 4 * s]);
    ctx.strokeStyle = 'rgba(168,85,247,0.95)';
    ctx.strokeRect(x, y, w, h);
    ctx.restore();
  }

  /* ============================================================
     Color sampling
     ============================================================ */
  function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('');
  }
  function applyPickedColor(hex) {
    state.color = hex;
    qAll('[data-custom-color]').forEach((el) => { try { el.value = hex; } catch (_) {} });
    updateSwatchSelection();
  }
  function startEyedropper() {
    if (!state.hasImage) { showToast('Load an image first'); return; }
    if (window.EyeDropper) {
      (async () => {
        try {
          const result = await new window.EyeDropper().open();
          if (result && result.sRGBHex) {
            applyPickedColor(result.sRGBHex);
            showToast('Color picked');
          }
        } catch (err) {
          if (err && err.name === 'AbortError') return;
          enterCanvasPickMode();
        }
      })();
      return;
    }
    enterCanvasPickMode();
  }
  function enterCanvasPickMode() {
    state.pickingColor = true;
    updateCanvasCursor();
    showToast('Tap anywhere on the image to pick its color');
  }
  function exitCanvasPickMode() { state.pickingColor = false; updateCanvasCursor(); }
  qAll('[data-eyedropper]').forEach((b) => b.addEventListener('click', startEyedropper));

  /* ============================================================
     Zoom
     ============================================================ */
  function applyZoom() {
    if (zoom.scale === 1 && zoom.tx === 0 && zoom.ty === 0) {
      canvas.style.transform = '';
      canvas.style.transformOrigin = '';
    } else {
      canvas.style.transformOrigin = 'center center';
      canvas.style.transform = `translate(${zoom.tx}px, ${zoom.ty}px) scale(${zoom.scale})`;
    }
    qAll('[data-zoom-level]').forEach((el) => {
      el.textContent = Math.round(zoom.scale * 100) + '%';
    });
  }

  function setZoom(newScale) {
    zoom.scale = Math.max(zoom.min, Math.min(zoom.max, newScale));
    if (zoom.scale === 1) { zoom.tx = 0; zoom.ty = 0; }
    applyZoom();
    updateZoomUI();
  }

  function resetZoom() {
    zoom.scale = 1; zoom.tx = 0; zoom.ty = 0;
    applyZoom();
    updateZoomUI();
  }

  function updateZoomUI() {
    const isZoomed = zoom.scale !== 1 || zoom.tx !== 0 || zoom.ty !== 0;
    const show = state.hasImage && (zoom.active || isZoomed);
    zoomControls.classList.toggle('hidden', !show);
    zoomControls.classList.toggle('flex', show);

    btnZoom.setAttribute('aria-pressed', zoom.active ? 'true' : 'false');
    btnZoom.innerHTML = zoom.active
      ? '<i data-lucide="check" class="w-4 h-4"></i><span class="hidden sm:inline">Done</span>'
      : '<i data-lucide="maximize-2" class="w-4 h-4"></i><span class="hidden sm:inline">Zoom</span>';
    refreshIcons();
  }

  function setZoomActive(on) {
    if (!state.hasImage) return;
    zoom.active = on;

    if (!on) {
      zoom.pointers.clear();
      zoom.isPanning = false;
      zoom.pinch = null;
    }

    document.body.classList.toggle('zoom-active', on);
    updateZoomUI();
    updateCanvasCursor();

    if (on) showToast('Drag to pan · pinch or scroll to zoom');
  }

  btnZoom.addEventListener('click', () => setZoomActive(!zoom.active));

  qAll('[data-zoom-in]').forEach((b) => b.addEventListener('click', () => setZoom(zoom.scale * 1.4)));
  qAll('[data-zoom-out]').forEach((b) => b.addEventListener('click', () => setZoom(zoom.scale / 1.4)));
  qAll('[data-zoom-fit]').forEach((b) => b.addEventListener('click', () => resetZoom()));

  canvas.addEventListener('wheel', (e) => {
    if (!zoom.active) return;
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    setZoom(zoom.scale * factor);
  }, { passive: false });

  /* ============================================================
     Pointer handling
     ============================================================ */
  function updateCanvasCursor() {
    if (zoom.active) { canvas.style.cursor = 'grab'; return; }
    if (state.pickingColor) { canvas.style.cursor = 'crosshair'; return; }
    if (state.tool === 'blur' || state.tool === 'mosaic') canvas.style.cursor = 'none';
    else if (state.tool === 'solid') canvas.style.cursor = 'crosshair';
    else canvas.style.cursor = 'default';
  }

  function updateCursorRing(e) {
    if (!state.hasImage || zoom.active || state.pickingColor ||
        (state.tool !== 'blur' && state.tool !== 'mosaic')) {
      cursorRing.style.display = 'none';
      return;
    }
    const rect = canvas.getBoundingClientRect();
    if (e.clientX < rect.left || e.clientX > rect.right ||
        e.clientY < rect.top  || e.clientY > rect.bottom) {
      cursorRing.style.display = 'none';
      return;
    }
    const parentRect = canvas.parentElement.getBoundingClientRect();
    cursorRing.style.display = 'block';

    // Brush footprint is constant in *screen* pixels, independent of zoom.
    cursorRing.style.width  = state.brushSize + 'px';
    cursorRing.style.height = state.brushSize + 'px';
    cursorRing.style.left = (e.clientX - parentRect.left) + 'px';
    cursorRing.style.top  = (e.clientY - parentRect.top)  + 'px';
  }

  function onPointerDown(e) {
    if (!state.hasImage) return;
    if (typeof e.button === 'number' && e.button !== 0) return;

    if (zoom.active) {
      e.preventDefault();
      try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
      zoom.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (zoom.pointers.size === 1) {
        zoom.isPanning = true;
        zoom.panStart = { x: e.clientX - zoom.tx, y: e.clientY - zoom.ty };
        canvas.style.cursor = 'grabbing';
      } else if (zoom.pointers.size === 2) {
        zoom.isPanning = false;
        const pts = [...zoom.pointers.values()];
        zoom.pinch = {
          dist: Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y),
          startScale: zoom.scale,
        };
      }
      return;
    }

    if (state.pickingColor) {
      e.preventDefault();
      cachedRect = canvas.getBoundingClientRect();
      const p = getCanvasPoint(e);
      const px = Math.min(canvas.width - 1,  Math.max(0, Math.floor(p.x)));
      const py = Math.min(canvas.height - 1, Math.max(0, Math.floor(p.y)));
      try {
        const data = ctx.getImageData(px, py, 1, 1).data;
        const hex = rgbToHex(data[0], data[1], data[2]);
        applyPickedColor(hex);
        showToast('Color picked');
      } catch (_) { showToast('Could not read pixel'); }
      exitCanvasPickMode();
      cachedRect = null;
      return;
    }

    if (!state.tool) return;
    e.preventDefault();

    hidePreview();
    cachedRect = canvas.getBoundingClientRect();
    state.strokeScale = canvas.width / cachedRect.width || 1;
    try { canvas.setPointerCapture(e.pointerId); } catch (_) {}

    const p = getCanvasPoint(e);
    state.drawing = true;
    state.startPoint = p;
    state.lastPoint = p;

    if (state.tool === 'solid') {
      const snap = document.createElement('canvas');
      snap.width = canvas.width; snap.height = canvas.height;
      snap.getContext('2d').drawImage(canvas, 0, 0);
      state.snapshotBefore = snap;
      drawSolidPreview(p, p);
    } else {
      const src = document.createElement('canvas');
      src.width = canvas.width; src.height = canvas.height;
      src.getContext('2d').drawImage(canvas, 0, 0);

      if (state.tool === 'blur') {
        state.strokeEffect = makeBlurred(src, effectBlurCanvasPx(state.strokeScale));
      } else {
        state.strokeEffect = makePixelated(src, effectMosaicCanvasPx(state.strokeScale));
      }

      const r = (state.brushSize / 2) * state.strokeScale;
      paintBrushSegment(p.x, p.y, p.x, p.y, r);
    }
  }

  function onPointerMove(e) {
    updateCursorRing(e);

    if (zoom.active) {
      if (!zoom.pointers.has(e.pointerId)) return;
      e.preventDefault();
      zoom.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (zoom.pointers.size === 1 && zoom.isPanning) {
        zoom.tx = e.clientX - zoom.panStart.x;
        zoom.ty = e.clientY - zoom.panStart.y;
        applyZoom();
        updateZoomUI();
      } else if (zoom.pointers.size === 2 && zoom.pinch) {
        const pts = [...zoom.pointers.values()];
        const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
        const ratio = dist / zoom.pinch.dist;
        setZoom(zoom.pinch.startScale * ratio);
      }
      return;
    }

    if (!state.drawing) return;
    e.preventDefault();
    const p = getCanvasPoint(e);

    if (state.tool === 'solid') {
      drawSolidPreview(state.startPoint, p);
      state.lastPoint = p;
    } else {
      const r = (state.brushSize / 2) * state.strokeScale;
      const last = state.lastPoint || p;
      paintBrushSegment(last.x, last.y, p.x, p.y, r);
      state.lastPoint = p;
    }
  }

  function onPointerUp(e) {
    if (zoom.active) {
      zoom.pointers.delete(e.pointerId);
      if (zoom.pointers.size === 0) {
        zoom.isPanning = false;
        zoom.pinch = null;
        if (zoom.active) canvas.style.cursor = 'grab';
      } else if (zoom.pointers.size === 1) {
        const pts = [...zoom.pointers.values()];
        zoom.isPanning = true;
        zoom.panStart = { x: pts[0].x - zoom.tx, y: pts[0].y - zoom.ty };
        zoom.pinch = null;
      }
      return;
    }

    if (!state.drawing) return;
    state.drawing = false;

    let changed = true;
    const p = getCanvasPoint(e);

    if (state.tool === 'solid') {
      const a = state.startPoint;
      const x = Math.min(a.x, p.x), y = Math.min(a.y, p.y);
      const w = Math.abs(p.x - a.x), h = Math.abs(p.y - a.y);

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(state.snapshotBefore, 0, 0);

      if (w >= 2 && h >= 2) {
        ctx.fillStyle = state.color;
        ctx.fillRect(x, y, w, h);
      } else {
        changed = false;
      }
    }

    state.startPoint = null;
    state.lastPoint = null;
    state.strokeEffect = null;
    state.snapshotBefore = null;
    cachedRect = null;

    if (changed) pushHistory();
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('pointerleave', () => {
    if (!state.drawing && !zoom.active) cursorRing.style.display = 'none';
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  /* ============================================================
     Tools
     ============================================================ */
  qAll('[data-tool]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (zoom.active) return;
      setTool(btn.dataset.tool);
    });
  });

  function setTool(tool) {
    if (state.pickingColor) exitCanvasPickMode();
    state.tool = state.tool === tool ? null : tool;
    qAll('[data-tool]').forEach((b) => {
      b.setAttribute('aria-pressed', b.dataset.tool === state.tool ? 'true' : 'false');
    });
    updateToolVisibility();
    updateCanvasCursor();
    if (state.tool !== 'blur' && state.tool !== 'mosaic') cursorRing.style.display = 'none';
    hidePreview();
  }

  function updateToolVisibility() {
    qAll('[data-blur-group]').forEach((el) => el.classList.toggle('hidden', state.tool !== 'blur'));
    qAll('[data-mosaic-group]').forEach((el) => el.classList.toggle('hidden', state.tool !== 'mosaic'));
    qAll('[data-color-group]').forEach((el) => el.classList.toggle('hidden', state.tool !== 'solid'));
    qAll('[data-brush-group]').forEach((el) =>
      el.classList.toggle('hidden', state.tool !== 'blur' && state.tool !== 'mosaic'));

    const hasTool = state.tool !== null;
    qAll('[data-adjust-empty]').forEach((el) => el.classList.toggle('hidden', hasTool));
    qAll('[data-adjust-content]').forEach((el) => el.classList.toggle('hidden', !hasTool));

    updateWarnings();
    requestAnimationFrame(fitCanvasToViewport);
  }

  /* ============================================================
     Effect preview circle
     ============================================================ */
  function hidePreview() {
    if (previewRAF) { cancelAnimationFrame(previewRAF); previewRAF = null; }
    clearTimeout(previewHideTimer);
    previewEl.classList.add('hidden');
    if (!state.drawing) cursorRing.style.display = 'none';
  }

  function brushSizeToDisplayDiameter(brushSize) {
    const MIN_BRUSH = 6;
    const MAX_BRUSH = 120;
    const MIN_DISP  = 38;
    const MAX_DISP  = 200;
    const t = Math.max(0, Math.min(1, (brushSize - MIN_BRUSH) / (MAX_BRUSH - MIN_BRUSH)));
    return Math.round(MIN_DISP + t * (MAX_DISP - MIN_DISP));
  }

  function showEffectPreview() {
    if (!state.hasImage) return;
    if (state.tool !== 'blur' && state.tool !== 'mosaic') return;

    const wrapEl   = canvas.parentElement;
    const wrapRect = wrapEl.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    if (!wrapRect.width || !canvasRect.width) return;

    const displayDiameter = brushSizeToDisplayDiameter(state.brushSize);
    const half = displayDiameter / 2 + 8;

    const vLeft   = Math.max(wrapRect.left,   canvasRect.left);
    const vRight  = Math.min(wrapRect.right,  canvasRect.right);
    const vTop    = Math.max(wrapRect.top,    canvasRect.top);
    const vBottom = Math.min(wrapRect.bottom, canvasRect.bottom);

    let px, py;
    if (vRight > vLeft && vBottom > vTop) {
      px = (vLeft + vRight) / 2;
      py = (vTop + vBottom) / 2;

      const visW = vRight - vLeft;
      const visH = vBottom - vTop;
      if (visW >= displayDiameter + 16) {
        px = Math.max(vLeft + half, Math.min(vRight - half, px));
      }
      if (visH >= displayDiameter + 16) {
        py = Math.max(vTop + half, Math.min(vBottom - half, py));
      }
    } else {
      px = wrapRect.left + wrapRect.width / 2;
      py = wrapRect.top  + wrapRect.height / 2;
    }

    previewEl.style.width  = displayDiameter + 'px';
    previewEl.style.height = displayDiameter + 'px';
    previewEl.style.left = (px - wrapRect.left) + 'px';
    previewEl.style.top  = (py - wrapRect.top)  + 'px';
    previewEl.classList.remove('hidden');

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const bufPx = Math.round(displayDiameter * dpr);
    previewCanvas.width  = bufPx;
    previewCanvas.height = bufPx;
    const pctx = previewCanvas.getContext('2d');

    // Use rect.width (rendered size) — correctly accounts for zoom/pan
    const canvasScale = canvas.width / canvasRect.width;
    const canvasPt = getCanvasPointFromScreen(px, py);

    const srcSize = Math.max(4, state.brushSize * canvasScale);
    const sx = Math.max(0, Math.min(canvas.width  - srcSize, canvasPt.x - srcSize / 2));
    const sy = Math.max(0, Math.min(canvas.height - srcSize, canvasPt.y - srcSize / 2));

    const region = document.createElement('canvas');
    region.width  = Math.max(1, Math.round(srcSize));
    region.height = Math.max(1, Math.round(srcSize));
    region.getContext('2d').drawImage(canvas, sx, sy, srcSize, srcSize, 0, 0, region.width, region.height);

    let eff;
    if (state.tool === 'blur') {
      eff = makeBlurred(region, effectBlurCanvasPx(canvasScale));
    } else {
      eff = makePixelated(region, effectMosaicCanvasPx(canvasScale));
    }

    pctx.clearRect(0, 0, bufPx, bufPx);
    if (eff) pctx.drawImage(eff, 0, 0, bufPx, bufPx);

    const grad = pctx.createLinearGradient(0, 0, bufPx, bufPx);
    grad.addColorStop(0,   '#ec4899');
    grad.addColorStop(0.5, '#a855f7');
    grad.addColorStop(1,   '#6366f1');

    const lineW = Math.max(2, 3 * dpr);
    pctx.beginPath();
    pctx.arc(bufPx / 2, bufPx / 2, bufPx / 2 - lineW / 2, 0, Math.PI * 2);
    pctx.strokeStyle = grad;
    pctx.lineWidth = lineW;
    pctx.stroke();
  }

  function triggerAdjustPreview() {
    if (previewRAF) cancelAnimationFrame(previewRAF);
    previewRAF = requestAnimationFrame(() => {
      previewRAF = null;
      if (state.tool !== 'blur' && state.tool !== 'mosaic') return;
      showEffectPreview();
      clearTimeout(previewHideTimer);
      previewHideTimer = setTimeout(() => previewEl.classList.add('hidden'), 1400);
    });
  }

  /* ============================================================
     Sliders / swatches
     ============================================================ */
  function bindRange(selector, onValue) {
    qAll(selector).forEach((el) => el.addEventListener('input', () => onValue(el.value)));
  }

  bindRange('[data-brush]', (v) => {
    state.brushSize = Number(v);
    qAll('[data-brush]').forEach((e) => { if (e.value !== v) e.value = v; });
    qAll('[data-brush-value]').forEach((e) => (e.textContent = v + 'px'));
    triggerAdjustPreview();
  });
  bindRange('[data-blur]', (v) => {
    state.blurStrength = Number(v);
    qAll('[data-blur]').forEach((e) => { if (e.value !== v) e.value = v; });
    qAll('[data-blur-value]').forEach((e) => (e.textContent = v));
    updateWarnings();
    triggerAdjustPreview();
  });
  bindRange('[data-mosaic]', (v) => {
    state.mosaicSize = Number(v);
    qAll('[data-mosaic]').forEach((e) => { if (e.value !== v) e.value = v; });
    qAll('[data-mosaic-value]').forEach((e) => (e.textContent = v));
    updateWarnings();
    triggerAdjustPreview();
  });

  qAll('[data-custom-color]').forEach((el) => {
    el.addEventListener('input', () => {
      state.color = el.value;
      qAll('[data-custom-color]').forEach((e) => { try { if (e.value !== el.value) e.value = el.value; } catch (_) {} });
      updateSwatchSelection();
    });
  });

  qAll('[data-color]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (zoom.active) return;
      state.color = btn.dataset.color;
      qAll('[data-custom-color]').forEach((e) => { try { e.value = state.color; } catch (_) {} });
      updateSwatchSelection();
    });
  });

  function updateSwatchSelection() {
    const t = state.color.toLowerCase();
    let matchedPreset = false;
    qAll('[data-color]').forEach((b) => {
      const active = b.dataset.color.toLowerCase() === t;
      b.classList.toggle('active', active);
      if (active) matchedPreset = true;
    });
    qAll('[data-custom-color-fill]').forEach((el) => { el.style.background = state.color; });
    qAll('[data-custom-color-label]').forEach((el) => el.classList.toggle('active', !matchedPreset));
    qAll('[data-current-color-tile]').forEach((el) => { el.style.background = state.color; });
  }

  /* ============================================================
     History buttons
     ============================================================ */
  qAll('[data-undo]').forEach((b) => b.addEventListener('click', () => { if (!zoom.active) undo(); }));
  qAll('[data-redo]').forEach((b) => b.addEventListener('click', () => { if (!zoom.active) redo(); }));
  qAll('[data-reset]').forEach((b) =>
    b.addEventListener('click', () => {
      if (zoom.active) return;
      if (!state.hasImage) return;
      if (!confirm('Clear the current image and all edits?')) return;

      canvas.width = 0; canvas.height = 0;
      canvas.style.width = ''; canvas.style.height = '';
      state.history = []; state.historyIndex = -1;
      historyChain = Promise.resolve();
      invalidateSizeCache();

      resetZoom();
      setTool(null);
      qAll('[data-tool]').forEach((x) => x.setAttribute('aria-pressed', 'false'));
      setHasImage(false);
    })
  );

  /* ============================================================
     Result screen
     ============================================================ */
  function updateResultFilenameExt() {
    const ext = state.format === 'image/png' ? '.png'
              : state.format === 'image/jpeg' ? '.jpg' : '.webp';
    filenameExt.textContent = ext;
  }

  resultFormat.addEventListener('change', () => {
    state.format = resultFormat.value;
    const needs = state.format !== 'image/png';
    resultQualityGroup.classList.toggle('hidden', !needs);
    updateResultFilenameExt();
    updateResultSize();
  });

  resultQuality.addEventListener('input', () => {
    state.quality = Number(resultQuality.value) / 100;
    resultQualityVal.textContent = resultQuality.value;
    updateResultSize();
  });

  function cleanFilenameInput() {
    return (filenameInput.value || '').trim().replace(/\.(png|jpe?g|webp)$/i, '') || 'redact-image';
  }

  btnResultDownload.addEventListener('click', () => {
    if (!state.hasImage) return;
    const ext = state.format === 'image/png' ? 'png'
              : state.format === 'image/jpeg' ? 'jpg' : 'webp';
    const name = cleanFilenameInput() + '.' + ext;

    const exportCanvas = makeExportCanvas();

    exportCanvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
    }, state.format, state.quality);
  });

  btnResultCopy.addEventListener('click', async () => {
    if (!state.hasImage) return;
    if (!navigator.clipboard || typeof window.ClipboardItem === 'undefined') {
      flashButton(btnResultCopy, 'Not supported', 'alert-circle');
      return;
    }
    try {
      const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
      if (!blob) throw new Error('encode failed');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      flashButton(btnResultCopy, 'Copied', 'check');
    } catch (_) {
      flashButton(btnResultCopy, 'Copy failed', 'x');
    }
  });

  /* ============================================================
     Lightbox
     ============================================================ */
  function openLightbox() {
    if (!resultImg.src) return;
    lightboxImg.src = resultImg.src;
    lightbox.classList.remove('hidden');
    lightbox.classList.add('flex');
    document.body.style.overflow = 'hidden';
    requestAnimationFrame(refreshIcons);
  }

  function closeLightbox() {
    if (!lightbox) return;
    lightbox.classList.add('hidden');
    lightbox.classList.remove('flex');
    document.body.style.overflow = '';
  }

  resultImg.addEventListener('click', openLightbox);
  lightboxClose.addEventListener('click', closeLightbox);
  lightbox.addEventListener('click', (e) => { if (e.target === lightbox) closeLightbox(); });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !lightbox.classList.contains('hidden')) {
      closeLightbox();
      e.stopPropagation();
      e.preventDefault();
    }
  }, true);

  /* ============================================================
     File input / drag & drop / paste
     ============================================================ */
  btnChoose.addEventListener('click', (e) => { e.stopPropagation(); fileInput.click(); });
  dropZone.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', () => {
    const f = fileInput.files && fileInput.files[0];
    if (f) loadImageFile(f);
    fileInput.value = '';
  });

  ['dragenter', 'dragover'].forEach((ev) => {
    window.addEventListener(ev, (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    });
  });

  if (landingDropZone) {
    ['dragenter', 'dragover'].forEach((ev) => {
      landingDropZone.addEventListener(ev, (e) => {
        e.preventDefault();
        landingDropZone.classList.add('drag-over');
      });
    });
    ['dragleave', 'drop'].forEach((ev) => {
      landingDropZone.addEventListener(ev, () => {
        landingDropZone.classList.remove('drag-over');
      });
    });
  }

  window.addEventListener('drop', (e) => {
    e.preventDefault();
    if (landingDropZone) landingDropZone.classList.remove('drag-over');
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) loadImageFile(f);
  });

  window.addEventListener('paste', (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type && item.type.startsWith('image/')) {
        const f = item.getAsFile();
        if (f) { e.preventDefault(); loadImageFile(f); return; }
      }
    }
  });

  /* ============================================================
     Keyboard shortcuts
     ============================================================ */
  window.addEventListener('keydown', (e) => {
    if (!lightbox.classList.contains('hidden')) return;
    const mod = e.ctrlKey || e.metaKey;
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo(); else undo();
      return;
    }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
    if (e.key === 'Escape') {
      if (state.pickingColor) exitCanvasPickMode();
      else if (zoom.active) setZoomActive(false);
      else setTool(null);
    }
  });

  /* ============================================================
     Init
     ============================================================ */
  function init() {
    setHasImage(false);
    updateSwatchSelection();
    updateCanvasCursor();
    updateToolVisibility();
    updateHistoryButtons();
    updateResultFilenameExt();
    updateZoomUI();
    updateWarnings();
    refreshIcons();
  }

  init();
})();