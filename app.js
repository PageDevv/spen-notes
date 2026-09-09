/**
 * S Pen Notes Canvas Engine
 * Optimized for Samsung Galaxy S + S Pen, Infinite Canvas, Real-Time Streaming & Built-in QR Scanner
 */

(function () {
  'use strict';

  // --- Элементы интерфейса ---
  const canvas = document.getElementById('noteCanvas');
  const ctx = canvas.getContext('2d', { alpha: true });
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const statusPill = document.getElementById('statusPill');
  const btnScanQR = document.getElementById('btnScanQR');
  const toast = document.getElementById('toast');
  const btnSend = document.getElementById('btnSend');
  const btnUndo = document.getElementById('btnUndo');
  const btnRedo = document.getElementById('btnRedo');
  const btnClear = document.getElementById('btnClear');
  const connectModal = document.getElementById('connectModal');
  const inputPeerId = document.getElementById('inputPeerId');
  const btnManualConnect = document.getElementById('btnManualConnect');
  const btnCancelModal = document.getElementById('btnCancelModal');

  // Элементы ползунка толщины пера
  const btnSizeToggle = document.getElementById('btnSizeToggle');
  const sizePopup = document.getElementById('sizePopup');
  const sizeRange = document.getElementById('sizeRange');
  const btnSizeMinus = document.getElementById('btnSizeMinus');
  const btnSizePlus = document.getElementById('btnSizePlus');
  const sizeValLabel = document.getElementById('sizeValLabel');
  const sizePreviewDot = document.getElementById('sizePreviewDot');
  const sizeIndicatorDot = document.getElementById('sizeIndicatorDot');

  // Элементы встроенного QR-сканера
  const scannerModal = document.getElementById('scannerModal');
  const btnCloseScanner = document.getElementById('btnCloseScanner');
  const qrVideo = document.getElementById('qrVideo');
  const qrScanCanvas = document.getElementById('qrScanCanvas');
  const btnOpenManualFromScanner = document.getElementById('btnOpenManualFromScanner');
  let cameraStream = null;
  let isScanningQR = false;

  // --- Состояние холста ---
  let currentColor = '#ffffff';
  let currentTool = 'pen'; // 'pen' | 'highlighter' | 'eraser'
  let currentBaseSize = 4;
  let strokes = [];
  let redoStack = [];
  let currentStroke = null;

  // Бесконечный холст: трансформация
  let panX = 0;
  let panY = 0;
  let scale = 1.0;
  let dpr = window.devicePixelRatio || 1;

  // Управление касаниями для навигации
  const activePointers = new Map();
  let initialPinchDistance = 0;
  let initialScale = 1.0;
  let isNavigating = false;
  let isPenDrawing = false;

  // Hold-to-Straighten
  let holdTimer = null;
  let holdStartPoint = null;
  let isLineSnapped = false;
  const HOLD_DURATION_MS = 420;
  const HOLD_DISTANCE_THRESHOLD = 12; // px

  // Сетевое подключение и реал-тайм стриминг
  let peer = null;
  let peerConn = null;
  let localWs = null;
  let isConnected = false;
  let targetSlotId = null;
  let streamThrottleTimer = null;
  let hasPendingStream = false;

  // Чтение параметров URL и localStorage
  const urlParams = new URLSearchParams(window.location.search);
  let targetPeerId = urlParams.get('peer');
  const targetWsHost = urlParams.get('ws');
  targetSlotId = urlParams.get('slot');

  if (!targetPeerId) {
    targetPeerId = localStorage.getItem('last_obsidian_peer_id');
  } else {
    localStorage.setItem('last_obsidian_peer_id', targetPeerId);
  }

  // =========================================================================
  // Инициализация Canvas
  // =========================================================================
  function resizeCanvas() {
    dpr = window.devicePixelRatio || 1;
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    redrawCanvas();
  }

  window.addEventListener('resize', resizeCanvas);

  function screenToWorld(sx, sy) {
    return {
      x: (sx - panX) / scale,
      y: (sy - panY) / scale
    };
  }

  // =========================================================================
  // Отрисовка
  // =========================================================================
  function redrawCanvas() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    ctx.scale(dpr, dpr);
    ctx.translate(panX, panY);
    ctx.scale(scale, scale);

    drawBackgroundGrid();

    for (const stroke of strokes) {
      drawStroke(stroke);
    }

    if (currentStroke) {
      drawStroke(currentStroke);
    }
  }

  function drawBackgroundGrid() {
    const gridSize = 40;
    const viewLeft = -panX / scale;
    const viewTop = -panY / scale;
    const viewRight = viewLeft + window.innerWidth / scale;
    const viewBottom = viewTop + window.innerHeight / scale;

    const startX = Math.floor(viewLeft / gridSize) * gridSize;
    const startY = Math.floor(viewTop / gridSize) * gridSize;

    ctx.save();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
    for (let x = startX; x <= viewRight; x += gridSize) {
      for (let y = startY; y <= viewBottom; y += gridSize) {
        ctx.fillRect(x - 0.75, y - 0.75, 1.5, 1.5);
      }
    }
    ctx.restore();
  }

  function drawStroke(stroke) {
    if (!stroke.points || stroke.points.length === 0) return;

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (stroke.tool === 'highlighter') {
      ctx.globalAlpha = 0.4;
      ctx.strokeStyle = stroke.color;
      ctx.lineWidth = stroke.baseSize * 3;
      ctx.globalCompositeOperation = 'source-over';
    } else if (stroke.tool === 'eraser') {
      ctx.strokeStyle = '#090a0f';
      ctx.lineWidth = stroke.baseSize * 4;
      ctx.globalCompositeOperation = 'destination-out';
    } else {
      ctx.globalAlpha = 1.0;
      ctx.strokeStyle = stroke.color;
      ctx.lineWidth = stroke.baseSize;
      ctx.globalCompositeOperation = 'source-over';
    }

    const pts = stroke.points;

    if (stroke.isSnapped && pts.length >= 2) {
      const p0 = pts[0];
      const pLast = pts[pts.length - 1];
      ctx.lineWidth = stroke.baseSize;
      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y);
      ctx.lineTo(pLast.x, pLast.y);
      ctx.stroke();
      ctx.restore();
      return;
    }

    if (pts.length === 1) {
      ctx.beginPath();
      const r = (stroke.baseSize * (pts[0].pressure || 0.5)) / 2;
      ctx.arc(pts[0].x, pts[0].y, Math.max(r, 1), 0, Math.PI * 2);
      ctx.fillStyle = stroke.color;
      ctx.fill();
      ctx.restore();
      return;
    }

    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);

    for (let i = 1; i < pts.length - 1; i++) {
      const midX = (pts[i].x + pts[i + 1].x) / 2;
      const midY = (pts[i].y + pts[i + 1].y) / 2;
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, midX, midY);
    }

    ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
    ctx.stroke();
    ctx.restore();
  }

  // =========================================================================
  // Обработка S Pen & Pointer Events
  // =========================================================================
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);

  function onPointerDown(e) {
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);

    // Закрываем окно размера пера при начале рисования
    sizePopup.classList.remove('open');
    btnSizeToggle.classList.remove('active');

    if (e.pointerType === 'touch') {
      activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (activePointers.size === 1 && !isPenDrawing) {
        isNavigating = true;
      } else if (activePointers.size === 2) {
        const pts = Array.from(activePointers.values());
        initialPinchDistance = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        initialScale = scale;
      }
      return;
    }

    if (e.pointerType === 'pen' || e.pointerType === 'mouse') {
      isPenDrawing = true;
      isLineSnapped = false;

      let toolToUse = currentTool;
      if (e.buttons === 2 || e.button === 2) {
        toolToUse = 'eraser';
      }

      const worldPos = screenToWorld(e.clientX, e.clientY);
      const pressure = (e.pressure !== undefined && e.pressure > 0) ? e.pressure : 0.5;

      currentStroke = {
        tool: toolToUse,
        color: currentColor,
        baseSize: currentBaseSize * (toolToUse === 'pen' ? (0.6 + pressure * 0.8) : 1),
        points: [{ x: worldPos.x, y: worldPos.y, pressure, time: Date.now() }],
        isSnapped: false
      };

      holdStartPoint = { x: e.clientX, y: e.clientY };
      startHoldTimer(e.clientX, e.clientY);

      redrawCanvas();
    }
  }

  function onPointerMove(e) {
    e.preventDefault();

    if (e.pointerType === 'touch') {
      if (!activePointers.has(e.pointerId)) return;
      const prevPos = activePointers.get(e.pointerId);
      activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (activePointers.size === 1 && isNavigating && !isPenDrawing) {
        panX += (e.clientX - prevPos.x);
        panY += (e.clientY - prevPos.y);
        redrawCanvas();
      } else if (activePointers.size === 2) {
        const pts = Array.from(activePointers.values());
        const curDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        if (initialPinchDistance > 0) {
          const newScale = Math.min(Math.max(initialScale * (curDist / initialPinchDistance), 0.3), 4.0);
          const midX = (pts[0].x + pts[1].x) / 2;
          const midY = (pts[0].y + pts[1].y) / 2;
          panX = midX - (midX - panX) * (newScale / scale);
          panY = midY - (midY - panY) * (newScale / scale);
          scale = newScale;
          redrawCanvas();
        }
      }
      return;
    }

    if ((e.pointerType === 'pen' || e.pointerType === 'mouse') && currentStroke) {
      const worldPos = screenToWorld(e.clientX, e.clientY);
      const pressure = (e.pressure !== undefined && e.pressure > 0) ? e.pressure : 0.5;

      if (currentStroke.isSnapped) {
        const pts = currentStroke.points;
        pts[pts.length - 1] = { x: worldPos.x, y: worldPos.y, pressure, time: Date.now() };
        redrawCanvas();
        scheduleRealtimeStream();
        return;
      }

      currentStroke.points.push({ x: worldPos.x, y: worldPos.y, pressure, time: Date.now() });

      if (holdStartPoint) {
        const dist = Math.hypot(e.clientX - holdStartPoint.x, e.clientY - holdStartPoint.y);
        if (dist > HOLD_DISTANCE_THRESHOLD) {
          holdStartPoint = { x: e.clientX, y: e.clientY };
          startHoldTimer(e.clientX, e.clientY);
        }
      }

      redrawCanvas();
      scheduleRealtimeStream();
    }
  }

  function onPointerUp(e) {
    if (e.pointerType === 'touch') {
      activePointers.delete(e.pointerId);
      if (activePointers.size === 0) {
        isNavigating = false;
      }
      return;
    }

    if (e.pointerType === 'pen' || e.pointerType === 'mouse') {
      clearHoldTimer();
      isPenDrawing = false;

      if (currentStroke) {
        strokes.push(currentStroke);
        currentStroke = null;
        redoStack = [];
        redrawCanvas();
        // Моментально отправляем готовый штрих в реал-тайме
        sendRealtimeUpdate();
      }
    }
  }

  // =========================================================================
  // Hold-to-Straighten Engine
  // =========================================================================
  function startHoldTimer(sx, sy) {
    clearHoldTimer();
    holdTimer = setTimeout(() => {
      triggerStraighten();
    }, HOLD_DURATION_MS);
  }

  function clearHoldTimer() {
    if (holdTimer) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
  }

  function triggerStraighten() {
    if (!currentStroke || currentStroke.points.length < 3) return;

    currentStroke.isSnapped = true;
    isLineSnapped = true;

    if (navigator.vibrate) {
      navigator.vibrate(25);
    }

    showToast('Линия выровнена 📏');
    redrawCanvas();
    sendRealtimeUpdate();
  }

  // =========================================================================
  // Auto-Crop Engine
  // =========================================================================
  function exportCroppedPNG() {
    if (strokes.length === 0 && !currentStroke) {
      return null;
    }

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    const allStrokes = currentStroke ? [...strokes, currentStroke] : strokes;

    for (const stroke of allStrokes) {
      const strokeHalf = (stroke.baseSize * (stroke.tool === 'highlighter' ? 3 : 1)) / 2;
      const ptsToScan = stroke.isSnapped && stroke.points.length >= 2
        ? [stroke.points[0], stroke.points[stroke.points.length - 1]]
        : stroke.points;

      for (const p of ptsToScan) {
        if (p.x - strokeHalf < minX) minX = p.x - strokeHalf;
        if (p.y - strokeHalf < minY) minY = p.y - strokeHalf;
        if (p.x + strokeHalf > maxX) maxX = p.x + strokeHalf;
        if (p.y + strokeHalf > maxY) maxY = p.y + strokeHalf;
      }
    }

    if (minX === Infinity || maxX <= minX || maxY <= minY) {
      return null;
    }

    const padding = 28;
    const cropWidth = (maxX - minX) + padding * 2;
    const cropHeight = (maxY - minY) + padding * 2;

    const offCanvas = document.createElement('canvas');
    const scaleFactor = 2;
    offCanvas.width = Math.ceil(cropWidth * scaleFactor);
    offCanvas.height = Math.ceil(cropHeight * scaleFactor);

    const offCtx = offCanvas.getContext('2d', { alpha: true });
    offCtx.scale(scaleFactor, scaleFactor);
    offCtx.translate(-minX + padding, -minY + padding);

    for (const stroke of allStrokes) {
      drawStrokeOnContext(offCtx, stroke);
    }

    return offCanvas.toDataURL('image/png');
  }

  function drawStrokeOnContext(tCtx, stroke) {
    if (!stroke.points || stroke.points.length === 0) return;

    tCtx.save();
    tCtx.lineCap = 'round';
    tCtx.lineJoin = 'round';

    if (stroke.tool === 'highlighter') {
      tCtx.globalAlpha = 0.4;
      tCtx.strokeStyle = stroke.color;
      tCtx.lineWidth = stroke.baseSize * 3;
    } else if (stroke.tool === 'eraser') {
      tCtx.globalCompositeOperation = 'destination-out';
      tCtx.lineWidth = stroke.baseSize * 4;
    } else {
      tCtx.globalAlpha = 1.0;
      tCtx.strokeStyle = stroke.color;
      tCtx.lineWidth = stroke.baseSize;
    }

    const pts = stroke.points;

    if (stroke.isSnapped && pts.length >= 2) {
      tCtx.beginPath();
      tCtx.moveTo(pts[0].x, pts[0].y);
      tCtx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
      tCtx.stroke();
      tCtx.restore();
      return;
    }

    if (pts.length === 1) {
      tCtx.beginPath();
      const r = (stroke.baseSize * (pts[0].pressure || 0.5)) / 2;
      tCtx.arc(pts[0].x, pts[0].y, Math.max(r, 1), 0, Math.PI * 2);
      tCtx.fillStyle = stroke.color;
      tCtx.fill();
      tCtx.restore();
      return;
    }

    tCtx.beginPath();
    tCtx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length - 1; i++) {
      const midX = (pts[i].x + pts[i + 1].x) / 2;
      const midY = (pts[i].y + pts[i + 1].y) / 2;
      tCtx.quadraticCurveTo(pts[i].x, pts[i].y, midX, midY);
    }
    tCtx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
    tCtx.stroke();
    tCtx.restore();
  }

  // =========================================================================
  // Реал-тайм Стриминг заметок в Obsidian
  // =========================================================================
  function scheduleRealtimeStream() {
    if (streamThrottleTimer) {
      hasPendingStream = true;
      return;
    }

    sendRealtimeUpdate();

    streamThrottleTimer = setTimeout(() => {
      streamThrottleTimer = null;
      if (hasPendingStream) {
        hasPendingStream = false;
        scheduleRealtimeStream();
      }
    }, 120); // ~8 FPS для плавного реал-тайм отображения без перегрузки
  }

  function sendRealtimeUpdate() {
    const pngData = exportCroppedPNG();
    if (!pngData) return;

    const payload = {
      type: 'spen_stream',
      image: pngData,
      slotId: targetSlotId,
      timestamp: Date.now()
    };

    if (localWs && localWs.readyState === WebSocket.OPEN) {
      localWs.send(JSON.stringify(payload));
    } else if (peerConn && peerConn.open) {
      peerConn.send(payload);
    }
  }

  // =========================================================================
  // Выпадающий ползунок размера пера (Popup Slider)
  // =========================================================================
  function setBaseSize(val) {
    val = Math.max(1, Math.min(28, parseInt(val, 10) || 4));
    currentBaseSize = val;
    sizeRange.value = val;
    sizeValLabel.textContent = val + ' px';

    // Превью круга
    sizePreviewDot.style.width = Math.max(val * 1.5, 3) + 'px';
    sizePreviewDot.style.height = Math.max(val * 1.5, 3) + 'px';
    sizePreviewDot.style.backgroundColor = currentColor;

    // Индикатор в тулбаре
    const dotSize = Math.min(Math.max(val, 4), 16);
    sizeIndicatorDot.style.width = dotSize + 'px';
    sizeIndicatorDot.style.height = dotSize + 'px';
  }

  btnSizeToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = sizePopup.classList.toggle('open');
    btnSizeToggle.classList.toggle('active', isOpen);
    setBaseSize(currentBaseSize);
  });

  sizeRange.addEventListener('input', (e) => {
    setBaseSize(e.target.value);
  });

  btnSizeMinus.addEventListener('click', (e) => {
    e.stopPropagation();
    setBaseSize(currentBaseSize - 1);
  });

  btnSizePlus.addEventListener('click', (e) => {
    e.stopPropagation();
    setBaseSize(currentBaseSize + 1);
  });

  document.addEventListener('click', (e) => {
    if (!sizePopup.contains(e.target) && !btnSizeToggle.contains(e.target)) {
      sizePopup.classList.remove('open');
      btnSizeToggle.classList.remove('active');
    }
  });

  // =========================================================================
  // Встроенный QR-Сканер (Камера)
  // =========================================================================
  btnScanQR.addEventListener('click', () => {
    startQRScanner();
  });

  btnCloseScanner.addEventListener('click', () => {
    stopQRScanner();
  });

  btnOpenManualFromScanner.addEventListener('click', () => {
    stopQRScanner();
    connectModal.classList.add('open');
  });

  async function startQRScanner() {
    try {
      scannerModal.classList.add('open');
      isScanningQR = true;

      const constraints = {
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 }
        }
      };

      cameraStream = await navigator.mediaDevices.getUserMedia(constraints);
      qrVideo.srcObject = cameraStream;
      await qrVideo.play();

      requestAnimationFrame(scanLoop);
    } catch (err) {
      console.error('Camera error:', err);
      showToast('Не удалось включить камеру');
      stopQRScanner();
      connectModal.classList.add('open');
    }
  }

  function stopQRScanner() {
    isScanningQR = false;
    scannerModal.classList.remove('open');
    if (cameraStream) {
      cameraStream.getTracks().forEach((track) => track.stop());
      cameraStream = null;
    }
    qrVideo.srcObject = null;
  }

  function scanLoop() {
    if (!isScanningQR) return;

    if (qrVideo.readyState === qrVideo.HAVE_ENOUGH_DATA) {
      if ('BarcodeDetector' in window) {
        const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
        detector.detect(qrVideo).then((barcodes) => {
          if (barcodes && barcodes.length > 0) {
            handleScannedQR(barcodes[0].rawValue);
          } else if (isScanningQR) {
            requestAnimationFrame(scanLoop);
          }
        }).catch(() => {
          fallbackJsQR();
        });
        return;
      }
      fallbackJsQR();
    } else {
      requestAnimationFrame(scanLoop);
    }
  }

  function fallbackJsQR() {
    if (!isScanningQR) return;
    try {
      const vWidth = qrVideo.videoWidth;
      const vHeight = qrVideo.videoHeight;
      if (vWidth > 0 && vHeight > 0) {
        qrScanCanvas.width = vWidth;
        qrScanCanvas.height = vHeight;
        const sCtx = qrScanCanvas.getContext('2d');
        sCtx.drawImage(qrVideo, 0, 0, vWidth, vHeight);
        const imgData = sCtx.getImageData(0, 0, vWidth, vHeight);

        if (typeof jsQR !== 'undefined') {
          const code = jsQR(imgData.data, vWidth, vHeight, {
            inversionAttempts: 'dontInvert'
          });
          if (code && code.data) {
            handleScannedQR(code.data);
            return;
          }
        }
      }
    } catch (e) {}

    if (isScanningQR) {
      requestAnimationFrame(scanLoop);
    }
  }

  function handleScannedQR(rawData) {
    if (!rawData) return;
    stopQRScanner();

    if (navigator.vibrate) {
      navigator.vibrate([40, 50, 40]);
    }

    console.log('Scanned QR Raw:', rawData);

    let extractedPeer = null;
    let extractedWs = null;
    let extractedSlot = null;

    try {
      if (rawData.startsWith('http://') || rawData.startsWith('https://') || rawData.startsWith('spen://')) {
        const u = new URL(rawData.replace('spen://', 'https://'));
        extractedPeer = u.searchParams.get('peer');
        extractedWs = u.searchParams.get('ws');
        extractedSlot = u.searchParams.get('slot');
      } else {
        extractedPeer = rawData.trim();
      }
    } catch (e) {
      extractedPeer = rawData.trim();
    }

    if (extractedSlot) {
      targetSlotId = extractedSlot;
    }

    if (extractedPeer) {
      targetPeerId = extractedPeer;
      localStorage.setItem('last_obsidian_peer_id', targetPeerId);
    }

    showToast('QR распознан! Подключение... ⚡');

    if (extractedWs) {
      connectLocalWs(extractedWs, false, (success) => {
        if (!success && extractedPeer) {
          connectCloudPeer(extractedPeer);
        }
      });
    } else if (extractedPeer) {
      connectCloudPeer(extractedPeer);
    }
  }

  // =========================================================================
  // Сетевое подключение: USB Direct -> Wi-Fi LAN -> PeerJS Cloud P2P
  // =========================================================================
  function initNetworking() {
    updateStatus('connecting', 'Поиск Obsidian...');

    connectLocalWs('127.0.0.1:39174', true, (usbConnected) => {
      if (usbConnected) return;

      if (targetWsHost && targetWsHost !== '127.0.0.1:39174') {
        connectLocalWs(targetWsHost, false, (lanConnected) => {
          if (lanConnected) return;
          tryCloudP2P();
        });
      } else {
        tryCloudP2P();
      }
    });
  }

  function tryCloudP2P() {
    if (targetPeerId) {
      connectCloudPeer(targetPeerId);
    } else {
      updateStatus('disconnected', 'Подключить');
    }
  }

  function connectCloudPeer(targetId) {
    updateStatus('connecting', 'P2P...');
    try {
      if (typeof Peer === 'undefined') {
        updateStatus('disconnected', 'Ошибка Peer');
        return;
      }

      if (peer) {
        try { peer.destroy(); } catch (e) {}
      }

      peer = new Peer({ debug: 1 });

      peer.on('open', (id) => {
        console.log('Mobile Peer ID:', id);
        const conn = peer.connect(targetId, { reliable: true });

        conn.on('open', () => {
          peerConn = conn;
          isConnected = true;
          updateStatus('connected', 'Obsidian (Cloud)');
          showToast('Подключено к Obsidian! ✨');

          conn.on('data', (data) => {
            handleIncomingData(data);
          });
        });

        conn.on('close', () => {
          isConnected = false;
          updateStatus('disconnected', 'Отключено');
        });

        conn.on('error', (err) => {
          console.error('Peer conn error:', err);
          updateStatus('disconnected', 'Сбой связи');
        });
      });

      peer.on('error', (err) => {
        console.error('Peer error:', err);
        updateStatus('disconnected', 'Сбой P2P');
      });
    } catch (err) {
      console.error(err);
      updateStatus('disconnected', 'Ошибка сети');
    }
  }

  function connectLocalWs(host, isUsbCheck, callback) {
    let settled = false;
    try {
      const wsUrl = `ws://${host}`;
      const tempWs = new WebSocket(wsUrl);

      const failTimeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          try { tempWs.close(); } catch (e) {}
          if (callback) callback(false);
        }
      }, 1500);

      tempWs.onopen = () => {
        if (settled) return;
        settled = true;
        clearTimeout(failTimeout);
        localWs = tempWs;
        isConnected = true;
        const modeName = isUsbCheck ? 'USB Direct' : 'Wi-Fi LAN';
        updateStatus('connected', `Obsidian (${modeName})`);
        showToast(`Подключено через ${modeName}! ⚡`);
        if (callback) callback(true);
      };

      tempWs.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          handleIncomingData(data);
        } catch (e) {}
      };

      tempWs.onerror = () => {
        if (!settled) {
          settled = true;
          clearTimeout(failTimeout);
          if (callback) callback(false);
        }
      };

      tempWs.onclose = () => {
        if (!peerConn) {
          isConnected = false;
          updateStatus('disconnected', 'Отключено');
        }
      };
    } catch (e) {
      if (!settled) {
        settled = true;
        if (callback) callback(false);
      }
    }
  }

  function updateStatus(state, text) {
    statusDot.className = 'status-dot ' + state;
    statusText.textContent = text;
  }

  function handleIncomingData(data) {
    if (data && data.type === 'note_received') {
      showToast('Зафиксировано в Obsidian! ✨');
      btnSend.classList.remove('sending');
      btnSend.querySelector('span').textContent = 'Отправить';
      strokes = [];
      redoStack = [];
      redrawCanvas();
    }
  }

  // =========================================================================
  // Фиксация заметки (кнопка Отправить)
  // =========================================================================
  btnSend.addEventListener('click', () => {
    const pngData = exportCroppedPNG();
    if (!pngData) {
      showToast('Нарисуйте заметку');
      return;
    }

    if (!isConnected && !peerConn && !localWs) {
      showToast('Сначала подключитесь к Obsidian');
      startQRScanner();
      return;
    }

    btnSend.classList.add('sending');
    btnSend.querySelector('span').textContent = 'Фиксация...';

    const payload = {
      type: 'spen_drawing',
      image: pngData,
      slotId: targetSlotId,
      timestamp: Date.now()
    };

    let sent = false;

    if (peerConn && peerConn.open) {
      peerConn.send(payload);
      sent = true;
    }

    if (localWs && localWs.readyState === WebSocket.OPEN) {
      localWs.send(JSON.stringify(payload));
      sent = true;
    }

    if (sent) {
      setTimeout(() => {
        btnSend.classList.remove('sending');
        btnSend.querySelector('span').textContent = 'Отправить';
      }, 3000);
    } else {
      btnSend.classList.remove('sending');
      btnSend.querySelector('span').textContent = 'Отправить';
      showToast('Ошибка: канал связи недоступен');
    }
  });

  // =========================================================================
  // UI & Инструменты
  // =========================================================================
  document.querySelectorAll('.tool-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tool-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentTool = btn.dataset.tool;
    });
  });

  document.querySelectorAll('.color-dot').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.color-dot').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentColor = btn.dataset.color;
      sizePreviewDot.style.backgroundColor = currentColor;
      if (currentTool === 'eraser') {
        const penBtn = document.querySelector('[data-tool="pen"]');
        if (penBtn) penBtn.click();
      }
    });
  });

  btnUndo.addEventListener('click', () => {
    if (strokes.length > 0) {
      redoStack.push(strokes.pop());
      redrawCanvas();
      sendRealtimeUpdate();
    }
  });

  btnRedo.addEventListener('click', () => {
    if (redoStack.length > 0) {
      strokes.push(redoStack.pop());
      redrawCanvas();
      sendRealtimeUpdate();
    }
  });

  btnClear.addEventListener('click', () => {
    if (strokes.length === 0) return;
    if (confirm('Очистить весь холст?')) {
      strokes = [];
      redoStack = [];
      redrawCanvas();
      sendRealtimeUpdate();
    }
  });

  statusPill.addEventListener('click', () => {
    startQRScanner();
  });

  btnCancelModal.addEventListener('click', () => {
    connectModal.classList.remove('open');
  });

  btnManualConnect.addEventListener('click', () => {
    const val = inputPeerId.value.trim();
    if (val) {
      targetPeerId = val;
      localStorage.setItem('last_obsidian_peer_id', val);
      connectModal.classList.remove('open');
      connectCloudPeer(val);
    }
  });

  let toastTimer = null;
  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.classList.remove('show');
    }, 2500);
  }

  resizeCanvas();
  setBaseSize(4);
  initNetworking();
})();
