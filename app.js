/**
 * S Pen Notes Canvas Engine
 * Optimized for Samsung Galaxy S + S Pen, Infinite Canvas, Hold-to-Straighten & Obsidian P2P Sync
 */

(function () {
  'use strict';

  // --- Элементы интерфейса ---
  const canvas = document.getElementById('noteCanvas');
  const ctx = canvas.getContext('2d', { alpha: true });
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const statusPill = document.getElementById('statusPill');
  const toast = document.getElementById('toast');
  const btnSend = document.getElementById('btnSend');
  const btnUndo = document.getElementById('btnUndo');
  const btnRedo = document.getElementById('btnRedo');
  const btnClear = document.getElementById('btnClear');
  const btnZoomReset = document.getElementById('btnZoomReset');
  const connectModal = document.getElementById('connectModal');
  const inputPeerId = document.getElementById('inputPeerId');
  const btnManualConnect = document.getElementById('btnManualConnect');
  const btnCancelModal = document.getElementById('btnCancelModal');

  // --- Состояние холста ---
  let currentColor = '#ffffff';
  let currentTool = 'pen'; // 'pen' | 'highlighter' | 'eraser'
  let currentBaseSize = 4;
  let strokes = []; // массив всех завершенных штрихов
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

  // Hold-to-Straighten (выравнивание линии при задержке пера)
  let holdTimer = null;
  let holdStartPoint = null;
  let isLineSnapped = false;
  const HOLD_DURATION_MS = 420;
  const HOLD_DISTANCE_THRESHOLD = 12; // px

  // Сетевое подключение
  let peer = null;
  let peerConn = null;
  let localWs = null;
  let isConnected = false;
  let targetSlotId = null;

  // Чтение параметров URL и localStorage
  const urlParams = new URLSearchParams(window.location.search);
  let targetPeerId = urlParams.get('peer');
  const targetWsHost = urlParams.get('ws'); // например, 192.168.1.50:39174
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

  function worldToScreen(wx, wy) {
    return {
      x: wx * scale + panX,
      y: wy * scale + panY
    };
  }

  // =========================================================================
  // Отрисовка
  // =========================================================================
  function redrawCanvas() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Применяем масштаб DPR и трансформацию камеры
    ctx.scale(dpr, dpr);
    ctx.translate(panX, panY);
    ctx.scale(scale, scale);

    // Отрисовываем сетку фона (минималистичные точки для ориентации в пространстве)
    drawBackgroundGrid();

    // Рисуем завершенные штрихи
    for (const stroke of strokes) {
      drawStroke(stroke);
    }

    // Рисуем текущий активный штрих
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
      ctx.strokeStyle = '#0c0d12'; // цвет фона
      ctx.lineWidth = stroke.baseSize * 4;
      ctx.globalCompositeOperation = 'destination-out';
    } else {
      // Перо / Ink
      ctx.globalAlpha = 1.0;
      ctx.strokeStyle = stroke.color;
      ctx.lineWidth = stroke.baseSize;
      ctx.globalCompositeOperation = 'source-over';
    }

    const pts = stroke.points;

    // Если линия выровнена (Hold-to-Straighten)
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
      // Одиночная точка
      ctx.beginPath();
      const r = (stroke.baseSize * (pts[0].pressure || 0.5)) / 2;
      ctx.arc(pts[0].x, pts[0].y, Math.max(r, 1), 0, Math.PI * 2);
      ctx.fillStyle = stroke.color;
      ctx.fill();
      ctx.restore();
      return;
    }

    // Сглаживание квадратичными кривыми Безье
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

    // Палец (Touch): Palm rejection и навигация по холсту
    if (e.pointerType === 'touch') {
      activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (activePointers.size === 1 && !isPenDrawing) {
        isNavigating = true;
      } else if (activePointers.size === 2) {
        // Начало pinch-to-zoom
        const pts = Array.from(activePointers.values());
        initialPinchDistance = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        initialScale = scale;
      }
      return;
    }

    // S Pen (или мышь для тестирования на ПК)
    if (e.pointerType === 'pen' || e.pointerType === 'mouse') {
      isPenDrawing = true;
      isLineSnapped = false;

      // Проверяем кнопку пера S Pen (стирание на лету)
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

    // Навигация пальцами (1 палец - pan, 2 пальца - pinch zoom)
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
          // Зум относительно центра между пальцами
          const midX = (pts[0].x + pts[1].x) / 2;
          const midY = (pts[0].y + pts[1].y) / 2;
          panX = midX - (midX - panX) * (newScale / scale);
          panY = midY - (midY - panY) * (newScale / scale);
          scale = newScale;
          btnZoomReset.textContent = Math.round(scale * 100) + '%';
          redrawCanvas();
        }
      }
      return;
    }

    // Рисование S Pen
    if ((e.pointerType === 'pen' || e.pointerType === 'mouse') && currentStroke) {
      const worldPos = screenToWorld(e.clientX, e.clientY);
      const pressure = (e.pressure !== undefined && e.pressure > 0) ? e.pressure : 0.5;

      // Если линия уже выровнена (snapped), обновляем конечную точку прямой
      if (currentStroke.isSnapped) {
        const pts = currentStroke.points;
        pts[pts.length - 1] = { x: worldPos.x, y: worldPos.y, pressure, time: Date.now() };
        redrawCanvas();
        return;
      }

      // Добавляем точку к штриху
      currentStroke.points.push({ x: worldPos.x, y: worldPos.y, pressure, time: Date.now() });

      // Проверяем Hold-to-Straighten (удержание пера на месте)
      if (holdStartPoint) {
        const dist = Math.hypot(e.clientX - holdStartPoint.x, e.clientY - holdStartPoint.y);
        if (dist > HOLD_DISTANCE_THRESHOLD) {
          // Перо активно движется, перезапускаем таймер удержания от текущей точки
          holdStartPoint = { x: e.clientX, y: e.clientY };
          startHoldTimer(e.clientX, e.clientY);
        }
      }

      redrawCanvas();
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
        redoStack = []; // сброс redo при новом штрихе
        redrawCanvas();
      }
    }
  }

  // =========================================================================
  // Hold-to-Straighten Engine (Выравнивание линии при удержании пера)
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

    // Срабатывание выравнивания
    currentStroke.isSnapped = true;
    isLineSnapped = true;

    // Тактильный вибро-отклик
    if (navigator.vibrate) {
      navigator.vibrate(25);
    }

    showToast('Линия выровнена 📏');
    redrawCanvas();
  }

  // =========================================================================
  // Auto-Crop Engine (Автоматическая обрезка штрихов + Padding)
  // =========================================================================
  function exportCroppedPNG() {
    if (strokes.length === 0) {
      showToast('Нарисуйте заметку перед отправкой');
      return null;
    }

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const stroke of strokes) {
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
      showToast('Не удалось определить границы рисунка');
      return null;
    }

    // Эстетичный отступ (padding) для идеального отображения в Obsidian
    const padding = 28;
    const cropWidth = (maxX - minX) + padding * 2;
    const cropHeight = (maxY - minY) + padding * 2;

    // Оффскрин канвас с 2x плотностью для максимальной четкости (Retina)
    const offCanvas = document.createElement('canvas');
    const scaleFactor = 2;
    offCanvas.width = Math.ceil(cropWidth * scaleFactor);
    offCanvas.height = Math.ceil(cropHeight * scaleFactor);

    const offCtx = offCanvas.getContext('2d', { alpha: true });
    offCtx.scale(scaleFactor, scaleFactor);
    offCtx.translate(-minX + padding, -minY + padding);

    // Рисуем все штрихи на чистом прозрачном фоне
    for (const stroke of strokes) {
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
  // Сетевое подключение: PeerJS WebRTC + LAN WebSocket Fallback
  // =========================================================================
  function initNetworking() {
    // 1. Попытка LAN WebSocket (если передан IP компьютера)
    if (targetWsHost) {
      connectLocalWs(targetWsHost);
    }

    // 2. Попытка Cloud P2P через PeerJS
    if (targetPeerId) {
      connectCloudPeer(targetPeerId);
    } else if (!targetWsHost) {
      updateStatus('disconnected', 'Нажмите для настройки');
    }
  }

  function connectCloudPeer(targetId) {
    updateStatus('connecting', 'Подключение к P2P...');
    try {
      if (typeof Peer === 'undefined') {
        updateStatus('disconnected', 'PeerJS недоступен');
        return;
      }

      peer = new Peer({
        debug: 1
      });

      peer.on('open', (id) => {
        console.log('Mobile Peer ID:', id);
        const conn = peer.connect(targetId, { reliable: true });

        conn.on('open', () => {
          peerConn = conn;
          isConnected = true;
          updateStatus('connected', 'Obsidian подключен (Cloud P2P)');
          showToast('Подключено к Obsidian!');

          // Слушаем подтверждения
          conn.on('data', (data) => {
            handleIncomingData(data);
          });
        });

        conn.on('close', () => {
          isConnected = false;
          updateStatus('disconnected', 'Соединение закрыто');
        });

        conn.on('error', (err) => {
          console.error('Peer conn error:', err);
          updateStatus('disconnected', 'Ошибка соединения');
        });
      });

      peer.on('error', (err) => {
        console.error('Peer error:', err);
        updateStatus('disconnected', 'Ошибка P2P');
      });
    } catch (err) {
      console.error(err);
      updateStatus('disconnected', 'Сбой P2P');
    }
  }

  function connectLocalWs(host) {
    try {
      const wsUrl = `ws://${host}`;
      localWs = new WebSocket(wsUrl);

      localWs.onopen = () => {
        isConnected = true;
        updateStatus('connected', 'Obsidian подключен (LAN)');
        showToast('Подключено по Wi-Fi!');
      };

      localWs.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          handleIncomingData(data);
        } catch (e) {}
      };

      localWs.onclose = () => {
        if (!peerConn) {
          isConnected = false;
          updateStatus('disconnected', 'LAN отключен');
        }
      };
    } catch (e) {
      console.warn('Local WS failed:', e);
    }
  }

  function updateStatus(state, text) {
    statusDot.className = 'status-dot ' + state;
    statusText.textContent = text;
  }

  function handleIncomingData(data) {
    if (data && data.type === 'note_received') {
      showToast('Вставлено в заметку Obsidian! ✨');
      btnSend.classList.remove('sending');
      btnSend.querySelector('span').textContent = 'Отправить';
      // Очищаем холст для следующей заметки
      strokes = [];
      redoStack = [];
      redrawCanvas();
    }
  }

  // =========================================================================
  // Отправка заметки в Obsidian
  // =========================================================================
  btnSend.addEventListener('click', () => {
    const pngData = exportCroppedPNG();
    if (!pngData) return;

    if (!isConnected && !peerConn && !localWs) {
      showToast('Нет подключения к Obsidian. Отсканируйте QR');
      connectModal.classList.add('open');
      return;
    }

    btnSend.classList.add('sending');
    btnSend.querySelector('span').textContent = 'Отправка...';

    const payload = {
      type: 'spen_drawing',
      image: pngData,
      slotId: targetSlotId,
      timestamp: Date.now()
    };

    let sent = false;

    // Отправка через PeerJS DataChannel
    if (peerConn && peerConn.open) {
      peerConn.send(payload);
      sent = true;
    }

    // Отправка через локальный WebSocket
    if (localWs && localWs.readyState === WebSocket.OPEN) {
      localWs.send(JSON.stringify(payload));
      sent = true;
    }

    if (sent) {
      showToast('Заметка отправлена в Obsidian...');
      // Таймаут на случай задержки ответа
      setTimeout(() => {
        btnSend.classList.remove('sending');
        btnSend.querySelector('span').textContent = 'Отправить';
      }, 3000);
    } else {
      btnSend.classList.remove('sending');
      btnSend.querySelector('span').textContent = 'Отправить';
      showToast('Ошибка отправки: канал недоступен');
    }
  });

  // =========================================================================
  // UI & Инструменты
  // =========================================================================
  // Выбор инструмента
  document.querySelectorAll('.tool-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tool-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentTool = btn.dataset.tool;
    });
  });

  // Выбор цвета
  document.querySelectorAll('.color-dot').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.color-dot').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentColor = btn.dataset.color;
      if (currentTool === 'eraser') {
        // Переключаем обратно на перо при выборе цвета
        const penBtn = document.querySelector('[data-tool="pen"]');
        if (penBtn) penBtn.click();
      }
    });
  });

  // Выбор размера
  document.querySelectorAll('.size-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.size-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentBaseSize = parseInt(btn.dataset.size, 10);
    });
  });

  // Undo / Redo
  btnUndo.addEventListener('click', () => {
    if (strokes.length > 0) {
      redoStack.push(strokes.pop());
      redrawCanvas();
    }
  });

  btnRedo.addEventListener('click', () => {
    if (redoStack.length > 0) {
      strokes.push(redoStack.pop());
      redrawCanvas();
    }
  });

  // Очистка
  btnClear.addEventListener('click', () => {
    if (strokes.length === 0) return;
    if (confirm('Очистить весь холст?')) {
      strokes = [];
      redoStack = [];
      redrawCanvas();
    }
  });

  // Сброс масштаба и позиции
  btnZoomReset.addEventListener('click', () => {
    panX = 0;
    panY = 0;
    scale = 1.0;
    btnZoomReset.textContent = '100%';
    redrawCanvas();
  });

  // Статус / Ручное подключение
  statusPill.addEventListener('click', () => {
    connectModal.classList.add('open');
  });

  btnCancelModal.addEventListener('click', () => {
    connectModal.classList.remove('open');
  });

  btnManualConnect.addEventListener('click', () => {
    const val = inputPeerId.value.trim();
    if (val) {
      localStorage.setItem('last_obsidian_peer_id', val);
      connectModal.classList.remove('open');
      connectCloudPeer(val);
    }
  });

  // Всплывающее уведомление
  let toastTimer = null;
  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.classList.remove('show');
    }, 2500);
  }

  // Запуск
  resizeCanvas();
  initNetworking();
})();
