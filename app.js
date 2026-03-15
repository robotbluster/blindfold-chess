// ===== Blindfold Chess – app.js =====

const PIECE_SVG = key => `pieces/cburnett/${key}.svg`;

const DIFFICULTIES = [
  { skill: 0,  movetime: 100  },
  { skill: 2,  movetime: 200  },
  { skill: 4,  movetime: 350  },
  { skill: 6,  movetime: 500  },
  { skill: 8,  movetime: 750  },
  { skill: 10, movetime: 1000 },
  { skill: 12, movetime: 1500 },
  { skill: 14, movetime: 2000 },
  { skill: 17, movetime: 2500 },
  { skill: 20, movetime: 3000 },
];

// ===== Sound =====

const SFX = {
  move:    new Audio('sounds/Move.ogg'),
  capture: new Audio('sounds/Capture.ogg'),
  check:   new Audio('sounds/Check.ogg'),
  notify:  new Audio('sounds/GenericNotify.ogg'),
};

function playSound(name) {
  const sfx = SFX[name];
  if (!sfx) return;
  sfx.currentTime = 0;
  sfx.play().catch(() => {}); // silently ignore autoplay restrictions
}

// ===== State =====

let chess            = new Chess();
let engine           = null;
let engineReady      = false;
let gameActive       = false;
let waitingForEngine = false;
let playerColor      = 'w';
let chosenColor      = 'w';
let blindfolded      = false;
let manualFlip       = false; // user-toggled board flip (F key)
let selectedSq       = null;
let legalTargets     = [];
let pendingPromotion = null;
let lastMove         = null;
let moveList         = [];

// Engine game-ID: prevents stale bestmove from a previous game being applied
let gameId      = 0;
let engineGameId = -1;

// History / review
let fenHistory   = [];
let boardHistory = []; // chess.board() snapshots — avoids new Chess() on every render
let checkHistory = []; // { inCheck, turn } snapshots for check highlight
let moveFromTo   = [];
let viewIndex    = 0;

// Drag state
let mouseDownData = null;
let isDragging    = false;
let dragEl        = null;

// Voice state
let voiceEnabled  = false; // speech synthesis for engine move announcements

// AI Voice state
let isRecording    = false;
let aiThinking     = false;
let micStream      = null;
let micProcessor   = null;
let micSource      = null;
let micAudioCtx    = null;
let pcmChunks      = [];
let whisperPipeline = null;
let whisperLoading  = false;

// ===== Engine =====

async function initEngine() {
  setStatus('Loading Stockfish engine...');
  try {
    const resp = await fetch('https://cdnjs.cloudflare.com/ajax/libs/stockfish.js/10.0.2/stockfish.js');
    if (!resp.ok) throw new Error('fetch failed');
    const blob = new Blob([await resp.text()], { type: 'text/javascript' });
    engine = new Worker(URL.createObjectURL(blob));
    engine.onmessage = onEngineMessage;
    engine.postMessage('uci');
    engine.postMessage('isready');
  } catch {
    setStatus('Failed to load engine. Check your internet connection.');
  }
}

function onEngineMessage(e) {
  const line = e.data;

  if (line === 'readyok' && !engineReady) {
    engineReady = true;
    setStatus('Engine ready. Select a difficulty and start a new game.');
  }

  // BUG FIX 3: ignore bestmove from a previous game via engineGameId check
  if (line.startsWith('bestmove') && waitingForEngine && engineGameId === gameId) {
    waitingForEngine = false;
    const move = line.split(' ')[1];
    if (!move || move === '(none)') return;

    const from  = move.slice(0, 2);
    const to    = move.slice(2, 4);
    const promo = move[4] || undefined;

    const result = chess.move({ from, to, promotion: promo });
    if (!result) { console.error('Engine played illegal move:', move); return; }

    moveList.push(result.san);
    lastMove = { from, to };
    moveFromTo.push({ from, to });
    boardHistory.push(chess.board());
    checkHistory.push({ inCheck: chess.in_check(), turn: chess.turn() });
    fenHistory.push(chess.fen());
    viewIndex = fenHistory.length - 1;

    // Sound
    if (chess.in_check())    playSound('check');
    else if (result.captured) playSound('capture');
    else                      playSound('move');

    renderBoard();
    renderMoveHistory();
    updateNavButtons();

    if (chess.game_over()) { handleGameOver(); return; }

    if (voiceEnabled) speakMove(result.san, true);
    setStatus(`Engine played ${result.san}. Your move.`);
  }
}

function sendCmd(cmd) { if (engine) engine.postMessage(cmd); }

// ===== Engine move request =====

function requestEngineMove() {
  const diff = DIFFICULTIES[parseInt(document.getElementById('difficulty-select').value)];
  engineGameId     = gameId; // tie this request to the current game
  waitingForEngine = true;
  setStatus('Engine is thinking…');
  sendCmd('position fen ' + chess.fen());
  sendCmd('go movetime ' + diff.movetime);
}

// ===== Game setup =====

function startNewGame() {
  if (!engineReady) { setStatus('Engine not ready yet. Please wait…'); return; }

  // BUG FIX 3: cancel any in-flight engine calculation for the old game
  sendCmd('stop');
  gameId++;

  const idx      = parseInt(document.getElementById('difficulty-select').value);
  const diffName = document.getElementById('difficulty-select').options[idx].text;
  const diff     = DIFFICULTIES[idx];

  playerColor = chosenColor === 'r' ? (Math.random() < 0.5 ? 'w' : 'b') : chosenColor;

  chess            = new Chess();
  gameActive       = true;
  waitingForEngine = false;
  blindfolded      = false;
  manualFlip       = false;
  selectedSq       = null;
  legalTargets     = [];
  pendingPromotion = null;
  lastMove         = null;
  moveList         = [];
  fenHistory       = [chess.fen()];
  boardHistory     = [chess.board()];
  checkHistory     = [{ inCheck: false, turn: 'w' }];
  moveFromTo       = [];
  viewIndex        = 0;

  document.getElementById('toggle-vision-btn').textContent = 'Hide Board';
  document.getElementById('gameover-overlay').style.display = 'none';
  document.getElementById('resign-btn').disabled = false;

  sendCmd('ucinewgame');
  sendCmd('setoption name Hash value 16');
  sendCmd('setoption name Skill Level value ' + diff.skill);

  updatePlayerBoxes(diffName);
  renderBoard();
  renderMoveHistory();
  updateNavButtons();

  playSound('notify');
  setStatus(`${diffName} — You play ${playerColor === 'w' ? 'White' : 'Black'}. Click or drag to move.`);

  if (playerColor === 'b') requestEngineMove();
}

function updatePlayerBoxes(diffName) {
  const label = diffName || document.getElementById('difficulty-select')
    .options[parseInt(document.getElementById('difficulty-select').value)].text;

  document.getElementById('engine-level').textContent      = label;
  document.getElementById('player-color-label').textContent = playerColor === 'w' ? 'White' : 'Black';

  const engineColor = playerColor === 'w' ? 'b' : 'w';
  document.getElementById('opponent-avatar').textContent    = engineColor === 'w' ? '♔' : '♚';
  document.getElementById('player-avatar-icon').textContent = playerColor === 'w' ? '♔' : '♚';
}

// ===== Board rendering =====

function renderBoard() {
  const boardEl  = document.getElementById('board');
  boardEl.innerHTML = '';

  const reviewing  = inReviewMode();
  // PERF: use pre-stored snapshots instead of instantiating new Chess()
  const boardState = reviewing ? boardHistory[viewIndex] : chess.board();
  const chkInfo    = reviewing ? checkHistory[viewIndex]
                               : { inCheck: chess.in_check(), turn: chess.turn() };
  const hlMove     = reviewing ? (viewIndex > 0 ? moveFromTo[viewIndex - 1] : null) : lastMove;
  const flipped    = (playerColor === 'b') !== manualFlip;
  const myTurn     = gameActive && !waitingForEngine && !reviewing && chess.turn() === playerColor;

  boardEl.classList.toggle('my-turn',   myTurn);
  boardEl.classList.toggle('reviewing', reviewing);

  for (let vRow = 0; vRow < 8; vRow++) {
    for (let vCol = 0; vCol < 8; vCol++) {
      const row   = flipped ? 7 - vRow : vRow;
      const col   = flipped ? 7 - vCol : vCol;
      const sq    = coordsToSquare(row, col);
      const piece = boardState[row][col];

      const sqEl = document.createElement('div');
      sqEl.classList.add('square', (row + col) % 2 === 0 ? 'light' : 'dark');
      sqEl.dataset.sq = sq;

      if (hlMove && (sq === hlMove.from || sq === hlMove.to)) sqEl.classList.add('last-move');

      if (!reviewing) {
        if (selectedSq === sq)                               sqEl.classList.add('selected');
        if (isDragging && mouseDownData?.sq === sq)          sqEl.classList.add('dragging-from');
        if (legalTargets.includes(sq)) sqEl.classList.add(piece ? 'capture' : 'highlight');
      }

      if (chkInfo.inCheck && piece?.type === 'k' && piece.color === chkInfo.turn) {
        sqEl.classList.add('in-check');
      }

      if (vCol === 0) {
        const lbl = document.createElement('span');
        lbl.classList.add('coord', 'coord-rank');
        lbl.textContent = String(8 - row);
        sqEl.appendChild(lbl);
      }
      if (vRow === 7) {
        const lbl = document.createElement('span');
        lbl.classList.add('coord', 'coord-file');
        lbl.textContent = String.fromCharCode(97 + col);
        sqEl.appendChild(lbl);
      }

      if (piece && !blindfolded) {
        const img = document.createElement('img');
        img.classList.add('piece');
        img.src = PIECE_SVG(piece.color + piece.type.toUpperCase());
        img.draggable = false;
        sqEl.appendChild(img);
      }

      boardEl.appendChild(sqEl);
    }
  }
}

function coordsToSquare(row, col) { return String.fromCharCode(97 + col) + (8 - row); }

// ===== Move history =====

function renderMoveHistory() {
  const list = document.getElementById('moves-list');
  list.innerHTML = '';
  const activeMoveIdx = viewIndex - 1;

  for (let i = 0; i < moveList.length; i += 2) {
    const row = document.createElement('div');
    row.classList.add('move-row');

    const numEl = document.createElement('span');
    numEl.classList.add('move-num');
    numEl.textContent = (Math.floor(i / 2) + 1) + '.';
    row.appendChild(numEl);

    const wEl = document.createElement('span');
    wEl.classList.add('move-san');
    if (i === activeMoveIdx) wEl.classList.add('active');
    wEl.textContent = moveList[i];
    wEl.addEventListener('click', () => setViewIndex(i + 1));
    row.appendChild(wEl);

    if (moveList[i + 1] !== undefined) {
      const bEl = document.createElement('span');
      bEl.classList.add('move-san');
      if (i + 1 === activeMoveIdx) bEl.classList.add('active');
      bEl.textContent = moveList[i + 1];
      bEl.addEventListener('click', () => setViewIndex(i + 2));
      row.appendChild(bEl);
    }

    list.appendChild(row);
  }

  const activeEl = list.querySelector('.move-san.active');
  if (activeEl) activeEl.scrollIntoView({ block: 'nearest' });
}

// ===== Game over =====

function handleGameOver() {
  gameActive = false;
  document.getElementById('resign-btn').disabled = true;

  let reason;
  if      (chess.in_checkmate())          reason = ['lose_or_win', 'Checkmate'];
  else if (chess.in_stalemate())          reason = ['draw',        'Stalemate'];
  else if (chess.in_threefold_repetition()) reason = ['draw',     'Threefold Repetition'];
  else if (chess.insufficient_material()) reason = ['draw',        'Insufficient Material'];
  else if (chess.in_draw())               reason = ['draw',        '50-Move Rule']; // BUG FIX 4

  if (!reason) return;
  const [kind, label] = reason;

  if (kind === 'lose_or_win') {
    showGameOver(chess.turn() === playerColor ? 'lose' : 'win', label);
  } else {
    showGameOver('draw', label);
  }

  playSound('notify');
}

function showGameOver(result, reason) {
  const icon  = document.getElementById('gameover-icon');
  const title = document.getElementById('gameover-title');

  if (result === 'win')  { icon.textContent = '🏆'; title.textContent = 'You Win!'; title.className = 'result-win';  }
  else if (result === 'lose') { icon.textContent = '💀'; title.textContent = 'You Lose'; title.className = 'result-lose'; }
  else                   { icon.textContent = '½';  title.textContent = 'Draw';     title.className = 'result-draw'; }

  document.getElementById('gameover-subtitle').textContent = reason;
  document.getElementById('gameover-overlay').style.display = 'flex';

  if (voiceEnabled) {
    const resultText = result === 'win' ? 'You win!' : result === 'lose' ? 'You lose.' : 'Draw.';
    setTimeout(() => speak(`${resultText} ${reason}.`), 600);
  }
}

function resetToEntry() {
  document.getElementById('gameover-overlay').style.display = 'none';
  chess        = new Chess();
  gameActive   = false;
  selectedSq   = null;
  legalTargets = [];
  lastMove     = null;
  moveList     = [];
  fenHistory   = [chess.fen()];
  boardHistory = [chess.board()];
  checkHistory = [{ inCheck: false, turn: 'w' }];
  moveFromTo   = [];
  viewIndex    = 0;
  manualFlip   = false;
  blindfolded  = false;
  document.getElementById('toggle-vision-btn').textContent = 'Hide Board';
  document.getElementById('resign-btn').disabled = true;
  renderBoard();
  renderMoveHistory();
  updateNavButtons();
  setStatus('Engine ready. Select a difficulty and start a new game.');
}

// ===== Resign =====

function showResignModal() {
  document.getElementById('resign-modal').style.display = 'flex';
}

function hideResignModal() {
  document.getElementById('resign-modal').style.display = 'none';
}

function confirmResign() {
  hideResignModal();
  sendCmd('stop');
  gameActive       = false;
  waitingForEngine = false;
  document.getElementById('resign-btn').disabled = true;
  showGameOver('lose', 'Resignation');
  playSound('notify');
  if (voiceEnabled) setTimeout(() => speak('You resigned.'), 600);
}

// ===== Player move =====

function handleSquareClick(sq) {
  if (!gameActive || waitingForEngine || chess.turn() !== playerColor || inReviewMode()) return;
  const piece = chess.get(sq);

  if (selectedSq === sq) { // click same piece = deselect
    selectedSq = null; legalTargets = []; renderBoard(); return;
  }

  if (selectedSq && legalTargets.includes(sq)) { attemptMove(selectedSq, sq); return; }

  if (piece && piece.color === playerColor) {
    selectedSq   = sq;
    legalTargets = chess.moves({ square: sq, verbose: true }).map(m => m.to);
  } else {
    selectedSq = null; legalTargets = [];
  }
  renderBoard();
}

function attemptMove(from, to) {
  const piece  = chess.get(from);
  const toRank = parseInt(to[1]);
  const isPromo = piece?.type === 'p' &&
    ((piece.color === 'w' && toRank === 8) || (piece.color === 'b' && toRank === 1));

  if (isPromo) {
    pendingPromotion = { from, to };
    selectedSq = null; legalTargets = [];
    renderBoard();
    updatePromoModal(piece.color);
    document.getElementById('promotion-modal').style.display = 'flex';
    return;
  }
  executeMove(from, to, null);
}

function updatePromoModal(color) {
  document.querySelectorAll('.promo-btn').forEach(btn => {
    btn.querySelector('img').src = PIECE_SVG(color + btn.dataset.piece.toUpperCase());
  });
}

function executeMove(from, to, promotion) {
  const result = chess.move({ from, to, promotion: promotion || 'q' });
  if (!result) return;

  moveList.push(result.san);
  lastMove = { from, to };
  moveFromTo.push({ from, to });
  boardHistory.push(chess.board());
  checkHistory.push({ inCheck: chess.in_check(), turn: chess.turn() });
  fenHistory.push(chess.fen());
  viewIndex    = fenHistory.length - 1;
  selectedSq   = null;
  legalTargets = [];

  // Sound
  if (chess.in_check())    playSound('check');
  else if (result.captured) playSound('capture');
  else                      playSound('move');

  if (voiceEnabled) speakMove(result.san, false);

  renderBoard();
  renderMoveHistory();
  updateNavButtons();

  if (chess.game_over()) { handleGameOver(); return; }

  requestEngineMove();
}

// ===== Helpers =====

function setStatus(msg) { document.getElementById('status').textContent = msg; }
function squareFromEl(el) { const s = el?.closest('[data-sq]'); return s ? s.dataset.sq : null; }

// ===== Drag helpers =====

function spawnDragEl(piece, x, y) {
  dragEl = document.createElement('img');
  dragEl.id = 'drag-piece';
  dragEl.src = PIECE_SVG(piece.color + piece.type.toUpperCase());
  dragEl.draggable = false;
  document.body.appendChild(dragEl);
  document.body.classList.add('is-dragging');
  moveDragEl(x, y);
}

function moveDragEl(x, y) { if (dragEl) { dragEl.style.left = x + 'px'; dragEl.style.top = y + 'px'; } }

function destroyDragEl() {
  dragEl?.remove(); dragEl = null;
  document.body.classList.remove('is-dragging');
}

// ===== Cancel drag (shared by mouse & touch) =====

function cancelDrag() {
  if (!mouseDownData) return;
  if (isDragging) { destroyDragEl(); selectedSq = null; legalTargets = []; renderBoard(); }
  mouseDownData = null;
  isDragging    = false;
}

// ===== Mouse events =====

document.getElementById('board').addEventListener('mousedown', e => {
  const sq = squareFromEl(e.target);
  if (!sq || !gameActive || waitingForEngine || chess.turn() !== playerColor || inReviewMode()) return;
  e.preventDefault();
  mouseDownData = { sq, x: e.clientX, y: e.clientY };
  isDragging = false;
});

document.addEventListener('mousemove', e => {
  if (!mouseDownData) return;
  const piece = chess.get(mouseDownData.sq);
  if (!piece || piece.color !== playerColor) return;
  const dx = e.clientX - mouseDownData.x, dy = e.clientY - mouseDownData.y;
  if (!isDragging && Math.hypot(dx, dy) > 5) {
    isDragging   = true;
    selectedSq   = mouseDownData.sq;
    legalTargets = chess.moves({ square: mouseDownData.sq, verbose: true }).map(m => m.to);
    spawnDragEl(piece, e.clientX, e.clientY);
    renderBoard();
  }
  if (isDragging) moveDragEl(e.clientX, e.clientY);
});

document.addEventListener('mouseup', e => {
  if (!mouseDownData) return;
  if (isDragging) {
    destroyDragEl();
    const toSq   = squareFromEl(document.elementFromPoint(e.clientX, e.clientY));
    const fromSq = mouseDownData.sq;
    if (toSq && legalTargets.includes(toSq) && toSq !== fromSq) {
      mouseDownData = null; isDragging = false;
      attemptMove(fromSq, toSq); return;
    }
    selectedSq = null; legalTargets = []; renderBoard();
  } else {
    handleSquareClick(mouseDownData.sq);
  }
  mouseDownData = null; isDragging = false;
});

// Cancel drag on right-click, window blur, or mouse leaving the page
document.addEventListener('contextmenu', cancelDrag);
document.addEventListener('mouseleave',  cancelDrag);
window.addEventListener('blur',          cancelDrag);

// ===== Touch events =====

document.getElementById('board').addEventListener('touchstart', e => {
  const t  = e.touches[0];
  const sq = squareFromEl(t.target);
  // BUG FIX 2: also guard inReviewMode() on touch
  if (!sq || !gameActive || waitingForEngine || chess.turn() !== playerColor || inReviewMode()) return;
  e.preventDefault();
  mouseDownData = { sq, x: t.clientX, y: t.clientY };
  isDragging = false;
}, { passive: false });

document.addEventListener('touchmove', e => {
  if (!mouseDownData) return;
  const piece = chess.get(mouseDownData.sq);
  if (!piece || piece.color !== playerColor) return;
  const t = e.touches[0];
  const dx = t.clientX - mouseDownData.x, dy = t.clientY - mouseDownData.y;
  if (!isDragging && Math.hypot(dx, dy) > 5) {
    isDragging   = true;
    selectedSq   = mouseDownData.sq;
    legalTargets = chess.moves({ square: mouseDownData.sq, verbose: true }).map(m => m.to);
    spawnDragEl(piece, t.clientX, t.clientY);
    renderBoard();
  }
  if (isDragging) { e.preventDefault(); moveDragEl(t.clientX, t.clientY); }
}, { passive: false });

document.addEventListener('touchend', e => {
  if (!mouseDownData) return;
  const t = e.changedTouches[0];
  if (isDragging) {
    destroyDragEl();
    const toSq   = squareFromEl(document.elementFromPoint(t.clientX, t.clientY));
    const fromSq = mouseDownData.sq;
    if (toSq && legalTargets.includes(toSq) && toSq !== fromSq) {
      mouseDownData = null; isDragging = false;
      attemptMove(fromSq, toSq); return;
    }
    selectedSq = null; legalTargets = []; renderBoard();
  } else {
    handleSquareClick(mouseDownData.sq);
  }
  mouseDownData = null; isDragging = false;
});

// BUG FIX 1: cancel touch drag when OS interrupts (notification, call, etc.)
document.addEventListener('touchcancel', cancelDrag);

// ===== Modal event listeners =====

document.querySelectorAll('.promo-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.getElementById('promotion-modal').style.display = 'none';
    if (pendingPromotion) {
      const { from, to } = pendingPromotion;
      pendingPromotion = null;
      executeMove(from, to, btn.dataset.piece);
    }
  });
});

document.getElementById('resign-btn').addEventListener('click', () => {
  if (!gameActive) return;
  showResignModal();
});
document.getElementById('resign-confirm-btn').addEventListener('click', confirmResign);
document.getElementById('resign-cancel-btn').addEventListener('click',  hideResignModal);

document.querySelectorAll('.color-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.color-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    chosenColor = btn.dataset.color;
  });
});

document.getElementById('new-game-btn').addEventListener('click', startNewGame);
document.getElementById('gameover-btn').addEventListener('click', resetToEntry);
document.getElementById('gameover-close').addEventListener('click', () => {
  document.getElementById('gameover-overlay').style.display = 'none';
});

document.getElementById('toggle-vision-btn').addEventListener('click', () => {
  blindfolded = !blindfolded;
  renderBoard();
  document.getElementById('toggle-vision-btn').textContent = blindfolded ? 'Show Board' : 'Hide Board';
});

// ===== History navigation =====

function inReviewMode() { return viewIndex < fenHistory.length - 1; }

function setViewIndex(idx) {
  viewIndex    = Math.max(0, Math.min(idx, fenHistory.length - 1));
  selectedSq   = null;
  legalTargets = [];
  renderBoard();
  renderMoveHistory();
  updateNavButtons();
}

function updateNavButtons() {
  const atStart = viewIndex === 0;
  const atEnd   = viewIndex === fenHistory.length - 1;
  document.getElementById('nav-first').disabled = atStart;
  document.getElementById('nav-prev').disabled  = atStart;
  document.getElementById('nav-next').disabled  = atEnd;
  document.getElementById('nav-last').disabled  = atEnd;
  document.getElementById('review-label').style.display = inReviewMode() ? 'inline' : 'none';
}

document.getElementById('nav-first').addEventListener('click', () => setViewIndex(0));
document.getElementById('nav-prev').addEventListener('click',  () => setViewIndex(viewIndex - 1));
document.getElementById('nav-next').addEventListener('click',  () => setViewIndex(viewIndex + 1));
document.getElementById('nav-last').addEventListener('click',  () => setViewIndex(fenHistory.length - 1));

// ===== Keyboard shortcuts =====

document.addEventListener('keydown', e => {
  // Don't fire shortcuts when typing in an input
  if (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT') return;

  switch (e.key) {
    case 'ArrowLeft':  e.preventDefault(); setViewIndex(viewIndex - 1); break;
    case 'ArrowRight': e.preventDefault(); setViewIndex(viewIndex + 1); break;
    case 'ArrowUp':    e.preventDefault(); setViewIndex(0);                        break;
    case 'ArrowDown':  e.preventDefault(); setViewIndex(fenHistory.length - 1);    break;

    case 'f': case 'F':
      manualFlip = !manualFlip;
      renderBoard();
      break;

    case 'b': case 'B':
      blindfolded = !blindfolded;
      renderBoard();
      document.getElementById('toggle-vision-btn').textContent = blindfolded ? 'Show Board' : 'Hide Board';
      break;

    case 'n': case 'N':
      startNewGame();
      break;

    case 'Escape':
      if (document.getElementById('resign-modal').style.display === 'flex') {
        hideResignModal(); break;
      }
      if (document.getElementById('promotion-modal').style.display === 'flex') {
        document.getElementById('promotion-modal').style.display = 'none';
        pendingPromotion = null; renderBoard(); break;
      }
      if (selectedSq) { selectedSq = null; legalTargets = []; renderBoard(); }
      break;
  }
});

// ===== Voice System =====

// ── Speech Synthesis ──

const synth = window.speechSynthesis;

function speak(text) {
  if (!synth) return;
  synth.cancel();
  const utt = new SpeechSynthesisUtterance(text);
  utt.lang = 'en-US';
  utt.rate = 1.05;
  synth.speak(utt);
}

function speakMove(san, isEngine) {
  const text = sanToSpeech(san);
  speak(isEngine ? `Engine plays ${text}` : text);
}

function sanToSpeech(san) {
  if (san === 'O-O')   return 'kingside castle';
  if (san === 'O-O-O') return 'queenside castle';

  const pieceNames = { N: 'knight', B: 'bishop', R: 'rook', Q: 'queen', K: 'king' };
  let s = san;
  let suffix = '';
  if      (s.endsWith('#')) { suffix = ', checkmate'; s = s.slice(0, -1); }
  else if (s.endsWith('+')) { suffix = ', check';     s = s.slice(0, -1); }

  let promoText = '';
  const promoMatch = s.match(/=([NBRQ])$/);
  if (promoMatch) { promoText = `, promotes to ${pieceNames[promoMatch[1]]}`; s = s.slice(0, -2); }

  const isCapture = s.includes('x');
  s = s.replace('x', '');
  const target = s.slice(-2);
  const prefix = s.slice(0, -2);
  let pieceName = 'pawn';
  if (prefix.length > 0 && pieceNames[prefix[0]]) pieceName = pieceNames[prefix[0]];

  return `${pieceName} ${isCapture ? 'takes' : 'to'} ${target}${promoText}${suffix}`;
}

// ── Speaker toggle ──
document.getElementById('speaker-btn').addEventListener('click', () => {
  voiceEnabled = !voiceEnabled;
  const btn = document.getElementById('speaker-btn');
  btn.classList.toggle('active', voiceEnabled);
  btn.title = voiceEnabled ? 'Announcements on (click to mute)' : 'Announcements off (click to enable)';
});

// ── Whisper (local, in-browser via transformers.js) ──

async function initWhisper() {
  if (whisperPipeline || whisperLoading) return;
  whisperLoading = true;
  showVoicePanel();
  addChatMessage('system', 'Loading voice model (first time ~75MB, cached after)…');
  try {
    const { pipeline, env } = await import('https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2');
    env.allowLocalModels = false;
    whisperPipeline = await pipeline(
      'automatic-speech-recognition',
      'Xenova/whisper-tiny.en',
      {
        progress_callback: p => {
          if (p.status === 'progress' && p.total) {
            updateSystemMessage(`Downloading model… ${Math.round(p.loaded / p.total * 100)}%`);
          }
        },
      }
    );
    removeSystemMessages();
    addChatMessage('ai', 'Voice ready. Hold the mic button and say your move.');
  } catch (err) {
    removeSystemMessages();
    addChatMessage('ai', 'Failed to load voice model. Check your connection and try again.');
    console.error('Whisper init:', err);
    whisperLoading = false;
  }
}

async function transcribeAudio(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const audioCtx    = new (window.AudioContext || window.webkitAudioContext)();
  const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);

  let float32;
  if (Math.abs(audioBuffer.sampleRate - 16000) < 100) {
    float32 = audioBuffer.getChannelData(0);
  } else {
    const offCtx = new OfflineAudioContext(1, Math.ceil(audioBuffer.duration * 16000), 16000);
    const src    = offCtx.createBufferSource();
    src.buffer   = audioBuffer;
    src.connect(offCtx.destination);
    src.start();
    float32 = (await offCtx.startRendering()).getChannelData(0);
  }
  audioCtx.close();

  const result = await whisperPipeline(float32, { sampling_rate: 16000, language: 'english', task: 'transcribe' });
  return result.text?.trim();
}

// ── Push-to-talk mic button ──

const micBtn = document.getElementById('mic-btn');
micBtn.addEventListener('mousedown',   e => { e.preventDefault(); handleMicPress(); });
micBtn.addEventListener('mouseup',     e => { e.preventDefault(); handleMicRelease(); });
micBtn.addEventListener('mouseleave',  () => { if (isRecording) handleMicRelease(); });
micBtn.addEventListener('touchstart',  e => { e.preventDefault(); handleMicPress(); },   { passive: false });
micBtn.addEventListener('touchend',    e => { e.preventDefault(); handleMicRelease(); }, { passive: false });
micBtn.addEventListener('touchcancel', () => { if (isRecording) handleMicRelease(); });
micBtn.addEventListener('contextmenu', e => e.preventDefault());

async function handleMicPress() {
  if (aiThinking) return;
  if (!whisperPipeline) {
    initWhisper();
    return;
  }
  await startRecording();
}

async function handleMicRelease() {
  if (!isRecording) return;
  await stopAndProcess();
}

async function startRecording() {
  try {
    // Capture raw PCM at 16kHz — bypasses MediaRecorder encoding/decoding entirely
    micStream   = await navigator.mediaDevices.getUserMedia({ audio: true });
    micAudioCtx = new AudioContext({ sampleRate: 16000 });
    await micAudioCtx.resume(); // ensure context is not suspended
    micSource   = micAudioCtx.createMediaStreamSource(micStream);
    micProcessor = micAudioCtx.createScriptProcessor(4096, 1, 1);
    pcmChunks   = [];

    micProcessor.onaudioprocess = e => {
      pcmChunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    };

    micSource.connect(micProcessor);
    micProcessor.connect(micAudioCtx.destination);

    isRecording = true;
    showVoicePanel();
    updateMicUI();
    console.log('[Mic] Recording started (raw PCM @ 16kHz)');
  } catch (err) {
    showVoicePanel();
    addChatMessage('ai', 'Microphone error: ' + err.message);
    console.error('[Mic] Error:', err);
  }
}

async function stopAndProcess() {
  if (!isRecording) return;
  isRecording = false;
  aiThinking  = true;
  updateMicUI();

  micSource?.disconnect();
  micProcessor?.disconnect();
  micStream?.getTracks().forEach(t => t.stop());
  micAudioCtx?.close();

  const chunks = pcmChunks;
  pcmChunks = [];
  console.log('[Mic] Stopped. PCM chunks:', chunks.length);

  if (!chunks.length) {
    addChatMessage('ai', 'No audio captured — try holding the mic longer.');
    aiThinking = false; updateMicUI(); return;
  }

  // Merge all chunks into one Float32Array
  const totalLen = chunks.reduce((s, c) => s + c.length, 0);
  const float32  = new Float32Array(totalLen);
  let offset = 0;
  for (const chunk of chunks) { float32.set(chunk, offset); offset += chunk.length; }

  // Check audio level
  let maxAmp = 0;
  for (let i = 0; i < float32.length; i++) if (Math.abs(float32[i]) > maxAmp) maxAmp = Math.abs(float32[i]);
  console.log('[Mic] Duration:', (totalLen / 16000).toFixed(1), 's | Max amplitude:', maxAmp.toFixed(4));

  if (maxAmp < 0.001) {
    addChatMessage('ai', 'Mic captured silence. Check your microphone is not muted.');
    aiThinking = false; updateMicUI(); return;
  }

  // Normalize so Whisper can hear it clearly
  const normalized = new Float32Array(totalLen);
  for (let i = 0; i < float32.length; i++) normalized[i] = float32[i] / maxAmp * 0.9;

  addChatMessage('system', 'Transcribing…');

  try {
    const result     = await whisperPipeline(normalized, { sampling_rate: 16000, language: 'english', task: 'transcribe' });
    const transcript = result.text?.trim();
    console.log('[Whisper] Transcript:', transcript);
    removeSystemMessages();

    if (!transcript) {
      addChatMessage('ai', 'Nothing heard — try speaking closer to the mic.');
      aiThinking = false; updateMicUI(); return;
    }
    addChatMessage('user', transcript);
    handleTranscript(transcript);
  } catch (err) {
    removeSystemMessages();
    addChatMessage('ai', 'Transcription error: ' + (err.message || 'unknown'));
    console.error('[Whisper] Error:', err);
  }

  aiThinking = false;
  updateMicUI();
}

// ── Chess intent parser ──

const PIECE_NAMES  = { knight: 'n', horse: 'n', night: 'n', bishop: 'b', rook: 'r', tower: 'r', rock: 'r', queen: 'q', king: 'k', pawn: 'p' };
const PIECE_LABELS = { n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king', p: 'pawn' };

function parseVoiceMove(raw) {
  let t = raw.toLowerCase()
    .replace(/[''.,!?]/g, '')
    .replace(/\bone\b/g,   '1').replace(/\btwo\b/g,   '2')
    .replace(/\bthree\b/g, '3').replace(/\bfour\b/g,  '4')
    .replace(/\bfive\b/g,  '5').replace(/\bsix\b/g,   '6')
    .replace(/\bseven\b/g, '7').replace(/\beight\b/g, '8')
    .replace(/\bate\b/g,   '8').replace(/\bfor\b/g,   '4')
    .replace(/\bsee\b/g,   'c').replace(/\bsea\b/g,   'c')
    .replace(/\bbee\b/g,   'b').replace(/\bgee\b/g,   'g')
    .replace(/\baitch\b/g, 'h').replace(/\beach\b/g,  'h')
    .replace(/\baye\b/g,   'a')
    .replace(/\b([a-h])\s+([1-8])\b/g, '$1$2')
    .replace(/\s+/g, ' ').trim();

  if (/king\s*side|short\s*castle|castle\s*king/i.test(t))  return { type: 'castle', side: 'k' };
  if (/queen\s*side|long\s*castle|castle\s*queen/i.test(t)) return { type: 'castle', side: 'q' };

  let pieceType = null;
  for (const [word, type] of Object.entries(PIECE_NAMES)) {
    if (new RegExp(`\\b${word}\\b`).test(t)) { pieceType = type; break; }
  }

  const squares = [...t.matchAll(/\b([a-h][1-8])\b/g)].map(m => m[1]);
  if (!squares.length) return null;

  return {
    type:      'move',
    pieceType: pieceType || 'p',
    targetSq:  squares[squares.length - 1],
    fromSq:    squares.length >= 2 ? squares[0] : null,
  };
}

function handleTranscript(text) {
  const parsed = parseVoiceMove(text);

  if (!parsed) {
    const reply = 'Say a piece and square — for example, "knight e4" or "pawn to d5".';
    addChatMessage('ai', reply); speak(reply); return;
  }

  if (!gameActive || waitingForEngine || chess.turn() !== playerColor || inReviewMode()) {
    const reply = "It's not your turn right now.";
    addChatMessage('ai', reply); speak(reply); return;
  }

  if (parsed.type === 'castle') {
    const san   = parsed.side === 'k' ? 'O-O' : 'O-O-O';
    const legal = chess.moves({ verbose: true });
    const m     = legal.find(mv => mv.san === san);
    if (m) {
      const reply = parsed.side === 'k' ? 'Castling kingside.' : 'Castling queenside.';
      addChatMessage('ai', reply); speak(reply);
      executeMove(m.from, m.to, null);
    } else {
      const reply = "You can't castle right now.";
      addChatMessage('ai', reply); speak(reply);
    }
    return;
  }

  const { pieceType, targetSq, fromSq } = parsed;
  let candidates = chess.moves({ verbose: true }).filter(m => m.to === targetSq);
  if (pieceType) candidates = candidates.filter(m => m.piece === pieceType);
  if (fromSq)   candidates = candidates.filter(m => m.from === fromSq);

  if (candidates.length > 1 && candidates.every(m => m.flags.includes('p'))) {
    candidates = candidates.filter(m => m.promotion === 'q');
  }

  if (candidates.length === 0) {
    const reply = `No legal ${PIECE_LABELS[pieceType] || 'piece'} move to ${targetSq}.`;
    addChatMessage('ai', reply); speak(reply); return;
  }
  if (candidates.length === 1) {
    const m     = candidates[0];
    const reply = sanToSpeech(m.san);
    addChatMessage('ai', reply); speak(reply);
    executeMove(m.from, m.to, m.promotion || null); return;
  }

  const reply = `Ambiguous — did you mean ${candidates.map(m => m.san).join(' or ')}?`;
  addChatMessage('ai', reply); speak(reply);
}

// ── UI helpers ──

function updateMicUI() {
  const dot = document.getElementById('voice-dot');
  const lbl = document.getElementById('voice-status-text');
  micBtn.classList.toggle('recording', isRecording);
  micBtn.classList.toggle('thinking',  aiThinking);
  dot.classList.toggle('recording',    isRecording);
  dot.classList.toggle('thinking',     aiThinking);
  if      (isRecording) lbl.textContent = 'Listening…';
  else if (aiThinking)  lbl.textContent = 'Processing…';
  else                  lbl.textContent = 'Hold to speak';
}

function showVoicePanel() {
  document.getElementById('voice-panel').style.display = 'flex';
}

function addChatMessage(role, text) {
  const container = document.getElementById('chat-messages');
  const el = document.createElement('div');
  el.className = `chat-msg chat-${role}`;
  el.textContent = text;
  if (role === 'system') el.dataset.system = '1';
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
}

function updateSystemMessage(text) {
  const el = document.querySelector('#chat-messages .chat-msg[data-system]');
  if (el) el.textContent = text;
  else addChatMessage('system', text);
}

function removeSystemMessages() {
  document.querySelectorAll('#chat-messages .chat-msg[data-system]').forEach(el => el.remove());
}

// ===== Boot =====
renderBoard();
initEngine();
updateNavButtons();
