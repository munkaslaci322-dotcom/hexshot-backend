const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 3001;

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.url === '/health') {
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'ok', rooms: rooms.size, players: clients.size }));
  } else {
    res.writeHead(200);
    res.end('HexShot WebSocket Server running');
  }
});

const wss = new WebSocket.Server({ server });

// roomId -> { id, bet, players: [ws, ws], grid, scores, currentPlayer, bubbles, nextBubbles, timeLeft, timer, state }
const rooms = new Map();
// ws -> { roomId, playerIdx, walletAddress, publicKey }
const clients = new Map();

let roomCounter = 1000;

function sendTo(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function broadcast(room, data, excludeWs = null) {
  room.players.forEach(ws => {
    if (ws && ws !== excludeWs) sendTo(ws, data);
  });
}

function broadcastAll(room, data) {
  room.players.forEach(ws => sendTo(ws, data));
}

// ── GRID LOGIC (mirror of frontend) ──
const ROWS = 9, COLS = 10;
const COLORS = ['#ff3366','#22d3ee','#4ade80','#fbbf24','#a855f7','#fb923c'];

function initGrid() {
  const grid = [];
  for (let r = 0; r < ROWS; r++) {
    grid[r] = [];
    const cols = r % 2 === 0 ? COLS : COLS - 1;
    for (let c = 0; c < cols; c++) {
      grid[r][c] = (r < 5) ? COLORS[Math.floor(Math.random() * COLORS.length)] : null;
    }
  }
  return grid;
}

function randomColor() { return COLORS[Math.floor(Math.random() * COLORS.length)]; }

function getNeighbors(grid, r, c) {
  const dirs = (r % 2 === 0)
    ? [[-1,0],[-1,-1],[0,-1],[0,1],[1,0],[1,-1]]
    : [[-1,0],[-1,1],[0,-1],[0,1],[1,0],[1,1]];
  return dirs.map(([dr,dc])=>[r+dr,c+dc])
    .filter(([nr,nc])=>nr>=0&&nr<ROWS&&nc>=0&&grid[nr]&&nc<grid[nr].length);
}

function findGroup(grid, startR, startC, color) {
  const visited = new Set(), group = [], queue = [{r:startR,c:startC}];
  while (queue.length) {
    const {r,c} = queue.shift();
    const key = `${r},${c}`;
    if (visited.has(key)) continue;
    visited.add(key);
    if (r<0||r>=ROWS||c<0||c>=grid[r].length||grid[r][c]!==color) continue;
    group.push({r,c});
    for (const [nr,nc] of getNeighbors(grid,r,c))
      if (!visited.has(`${nr},${nc}`)) queue.push({r:nr,c:nc});
  }
  return group;
}

function removeFloating(grid) {
  const connected = new Set(), queue = [];
  for (let c = 0; c < grid[0].length; c++)
    if (grid[0][c]) { queue.push({r:0,c}); connected.add(`0,${c}`); }
  while (queue.length) {
    const {r,c} = queue.shift();
    for (const [nr,nc] of getNeighbors(grid,r,c)) {
      const key = `${nr},${nc}`;
      if (!connected.has(key) && grid[nr][nc]) { connected.add(key); queue.push({r:nr,c:nc}); }
    }
  }
  let count = 0;
  for (let r = 1; r < ROWS; r++)
    for (let c = 0; c < grid[r].length; c++)
      if (grid[r][c] && !connected.has(`${r},${c}`)) { grid[r][c] = null; count++; }
  return count;
}

function isGridEmpty(grid) {
  for (let r = 0; r < ROWS; r++)
    for (let c = 0; c < grid[r].length; c++)
      if (grid[r][c]) return false;
  return true;
}

function hexX(col, row) { return 21 + col * 21 * 2 + (row % 2) * 21; }
function hexY(row) { return 21 + row * 21 * 1.73; }

function findBestCell(grid, px, py) {
  const candidates = new Set();
  for (let r = 0; r < ROWS; r++)
    for (let c = 0; c < grid[r].length; c++)
      if (grid[r][c])
        for (const [nr,nc] of getNeighbors(grid,r,c))
          if (!grid[nr][nc]) candidates.add(`${nr},${nc}`);
  for (let c = 0; c < grid[0].length; c++)
    if (!grid[0][c]) candidates.add(`0,${c}`);

  let bestRow = -1, bestCol = -1, bestDist = Infinity;
  for (const key of candidates) {
    const [r,c] = key.split(',').map(Number);
    const d = Math.hypot(px - hexX(c,r), py - hexY(r));
    if (d < bestDist) { bestDist = d; bestRow = r; bestCol = c; }
  }
  return { row: bestRow, col: bestCol };
}

// ── ROOM MANAGEMENT ──
function createRoom(ws, bet, walletAddress) {
  const roomId = (roomCounter++).toString();
  const room = {
    id: roomId,
    bet,
    players: [ws, null],
    walletAddresses: [walletAddress, null],
    grid: initGrid(),
    scores: [0, 0],
    currentPlayer: 0,
    bubbles: [randomColor(), randomColor()],
    nextBubbles: [randomColor(), randomColor()],
    timeLeft: 4 * 60,
    timer: null,
    state: 'waiting', // waiting | playing | ended
    potPaid: [false, false],
  };
  rooms.set(roomId, room);
  clients.set(ws, { roomId, playerIdx: 0, walletAddress });
  sendTo(ws, { type: 'room_created', roomId, playerIdx: 0, bet, grid: room.grid, bubbles: room.bubbles, nextBubbles: room.nextBubbles });
  console.log(`Room ${roomId} created, bet: ${bet} SOL`);
  return roomId;
}

function joinRoom(ws, roomId, walletAddress) {
  const room = rooms.get(roomId);
  if (!room) { sendTo(ws, { type: 'error', msg: 'Room not found' }); return; }
  if (room.state !== 'waiting') { sendTo(ws, { type: 'error', msg: 'Room already started' }); return; }
  if (room.players[1]) { sendTo(ws, { type: 'error', msg: 'Room is full' }); return; }
  if (room.walletAddresses[0] === walletAddress) { sendTo(ws, { type: 'error', msg: 'Cannot play against yourself' }); return; }

  room.players[1] = ws;
  room.walletAddresses[1] = walletAddress;
  clients.set(ws, { roomId, playerIdx: 1, walletAddress });

  // Tell P2 full game state
  sendTo(ws, {
    type: 'room_joined', roomId, playerIdx: 1, bet: room.bet,
    grid: room.grid, bubbles: room.bubbles, nextBubbles: room.nextBubbles,
    opponent: room.walletAddresses[0]
  });

  // Tell P1 opponent joined
  sendTo(room.players[0], {
    type: 'opponent_joined', opponent: walletAddress
  });

  console.log(`Room ${roomId}: P2 joined (${walletAddress})`);
  startGame(room);
}

function startGame(room) {
  room.state = 'playing';
  broadcastAll(room, {
    type: 'game_start',
    grid: room.grid,
    bubbles: room.bubbles,
    nextBubbles: room.nextBubbles,
    currentPlayer: 0
  });

  room.timer = setInterval(() => {
    room.timeLeft--;
    broadcastAll(room, { type: 'timer', timeLeft: room.timeLeft });
    if (room.timeLeft <= 0) {
      clearInterval(room.timer);
      endGame(room, 'time');
    }
  }, 1000);
}

function processShot(room, playerIdx, landX, landY) {
  if (room.currentPlayer !== playerIdx) return; // not your turn
  const color = room.bubbles[playerIdx];
  const { row, col } = findBestCell(room.grid, landX, landY);

  if (row === -1) { endGame(room, 'clear'); return; }

  room.grid[row][col] = color;

  // Prepare next bubble
  room.bubbles[playerIdx] = room.nextBubbles[playerIdx];
  room.nextBubbles[playerIdx] = randomColor();

  // Check group
  const group = findGroup(room.grid, row, col, color);
  let popped = 0, fallen = 0;
  if (group.length >= 2) {
    for (const {r,c} of group) { room.grid[r][c] = null; popped++; }
    room.scores[playerIdx] += popped;
    fallen = removeFloating(room.grid);
    room.scores[playerIdx] += fallen;
  }

  // Switch player
  room.currentPlayer = 1 - playerIdx;

  // Broadcast result
  broadcastAll(room, {
    type: 'shot_result',
    playerIdx,
    placedRow: row,
    placedCol: col,
    placedColor: color,
    popped: group.length >= 2 ? group.map(g=>({r:g.r,c:g.c})) : [],
    fallen,
    scores: room.scores,
    currentPlayer: room.currentPlayer,
    bubbles: room.bubbles,
    nextBubbles: room.nextBubbles,
    grid: room.grid,
  });

  if (isGridEmpty(room.grid)) {
    setTimeout(() => endGame(room, 'clear'), 500);
  }
}

function endGame(room, reason) {
  if (room.state === 'ended') return;
  room.state = 'ended';
  if (room.timer) clearInterval(room.timer);

  const [s0, s1] = room.scores;
  let winner = s0 > s1 ? 0 : s1 > s0 ? 1 : -1; // -1 = draw

  broadcastAll(room, {
    type: 'game_end',
    reason,
    scores: room.scores,
    winner, // 0, 1, or -1 (draw)
    walletAddresses: room.walletAddresses,
    bet: room.bet,
  });

  console.log(`Room ${room.id} ended. Winner: ${winner}, scores: ${s0}-${s1}, reason: ${reason}`);

  // Clean up room after 30s
  setTimeout(() => rooms.delete(room.id), 30000);
}

// ── WEBSOCKET HANDLER ──
wss.on('connection', (ws) => {
  console.log('Client connected');

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'create_room':
        if (!msg.bet || msg.bet < 0.01) { sendTo(ws, { type: 'error', msg: 'Minimum bet is 0.01 SOL' }); return; }
        createRoom(ws, msg.bet, msg.walletAddress || 'demo');
        break;

      case 'join_room':
        joinRoom(ws, msg.roomId, msg.walletAddress || 'demo');
        break;

      case 'shoot':
        const info = clients.get(ws);
        if (!info) return;
        const room = rooms.get(info.roomId);
        if (!room || room.state !== 'playing') return;
        processShot(room, info.playerIdx, msg.landX, msg.landY);
        break;

      case 'chat':
        const cInfo = clients.get(ws);
        if (!cInfo) return;
        const cRoom = rooms.get(cInfo.roomId);
        if (!cRoom) return;
        broadcast(cRoom, { type: 'chat', playerIdx: cInfo.playerIdx, text: msg.text }, ws);
        break;

      case 'forfeit':
        const fInfo = clients.get(ws);
        if (!fInfo) return;
        const fRoom = rooms.get(fInfo.roomId);
        if (!fRoom || fRoom.state !== 'playing') return;
        // Winner is the other player
        fRoom.scores[fInfo.playerIdx] = -999; // ensure loss
        endGame(fRoom, 'forfeit');
        break;

      case 'ping':
        sendTo(ws, { type: 'pong' });
        break;
    }
  });

  ws.on('close', () => {
    const info = clients.get(ws);
    if (info) {
      const room = rooms.get(info.roomId);
      if (room && room.state === 'playing') {
        // Other player wins
        const winnerIdx = 1 - info.playerIdx;
        sendTo(room.players[winnerIdx], { type: 'opponent_disconnected' });
        endGame(room, 'forfeit');
      }
      clients.delete(ws);
    }
    console.log('Client disconnected');
  });

  ws.on('error', (e) => console.error('WS error:', e.message));
});

server.listen(PORT, () => console.log(`HexShot server running on port ${PORT}`));
