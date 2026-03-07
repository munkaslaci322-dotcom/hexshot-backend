const { WebSocketServer, WebSocket } = require('ws');
const http = require('http');
const { Connection, PublicKey, Keypair, Transaction, SystemProgram } = require('@solana/web3.js');
const bs58 = require('bs58');

const PORT = process.env.PORT || 3001;
const HOUSE_WALLET = 'D9hP3M6ZWb2DrZ42EuzjLxFescFdmsocTQbcGmRDTPV';
const SOLANA_RPC = 'https://api.mainnet-beta.solana.com';
const HOUSE_FEE = 0.05; // 5%

// Load house keypair from env (base58 private key)
let houseKeypair = null;
if (process.env.HOUSE_KEYPAIR) {
  try {
    houseKeypair = Keypair.fromSecretKey(bs58.decode(process.env.HOUSE_KEYPAIR));
    console.log('House keypair loaded:', houseKeypair.publicKey.toString());
  } catch(e) {
    console.warn('Failed to load HOUSE_KEYPAIR:', e.message);
  }
}

const connection = new Connection(SOLANA_RPC, 'confirmed');
const rooms = new Map();

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', rooms: rooms.size }));
});

const wss = new WebSocketServer({ server });

function send(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}
function broadcast(room, msg) {
  room.players.forEach(p => send(p.ws, msg));
}
function generateGrid() {
  const C = ['#ef4444','#3b82f6','#22c55e','#f59e0b','#a855f7','#06b6d4'];
  return Array.from({length:9}, () => Array.from({length:10}, () => C[Math.floor(Math.random()*C.length)]));
}

// Pay winner from house wallet
async function payWinner(winnerAddress, amountSol) {
  if (!houseKeypair) {
    console.warn('No house keypair — cannot pay winner automatically');
    return null;
  }
  try {
    const lamports = Math.round(amountSol * 1e9);
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: houseKeypair.publicKey,
        toPubkey: new PublicKey(winnerAddress),
        lamports,
      })
    );
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = houseKeypair.publicKey;
    tx.sign(houseKeypair);
    const sig = await connection.sendRawTransaction(tx.serialize());
    await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
    console.log(`Paid ${amountSol} SOL to ${winnerAddress} — tx: ${sig}`);
    return sig;
  } catch(e) {
    console.error('payWinner error:', e.message);
    return null;
  }
}

async function settleGame(room, winnerIdx) {
  if (room.settled) return;
  room.settled = true;
  clearInterval(room.timer);

  const totalPot = room.bet * 2;
  const fee = totalPot * HOUSE_FEE;
  const winnerPayout = totalPot - fee;

  const winner = winnerIdx !== null ? room.players[winnerIdx] : null;
  const scores = room.players.map(p => p.score);

  broadcast(room, {
    type: 'game_end',
    winner: winnerIdx,
    scores,
    payout: winnerPayout,
    fee,
  });

  if (winner?.walletAddress && winnerPayout > 0) {
    console.log(`Settling: ${winnerPayout} SOL → ${winner.walletAddress}`);
    const sig = await payWinner(winner.walletAddress, winnerPayout);
    if (sig) broadcast(room, { type: 'payout_sent', sig, amount: winnerPayout });
  } else if (!winner) {
    // Draw — refund both
    for (const p of room.players) {
      if (p.walletAddress) await payWinner(p.walletAddress, room.bet);
    }
  }

  rooms.delete(room.id);
}

function startTimer(room) {
  room.timeLeft = 240;
  room.timer = setInterval(async () => {
    room.timeLeft--;
    broadcast(room, { type: 'timer', timeLeft: room.timeLeft });
    if (room.timeLeft <= 0) {
      const s = room.players.map(p => p.score);
      const winner = s[0] > s[1] ? 0 : s[1] > s[0] ? 1 : null;
      await settleGame(room, winner);
    }
  }, 1000);
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => ws.isAlive = true);

  ws.on('message', async (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg.type === 'ping') { send(ws, { type: 'pong' }); return; }

    if (msg.type === 'create_room') {
      const roomId = msg.roomId || Math.floor(1000 + Math.random() * 9000).toString();
      const room = {
        id: roomId, bet: msg.bet || 0, settled: false,
        players: [{ ws, walletAddress: msg.walletAddress, score: 0 }],
        grid: generateGrid(), turn: 0, timer: null, timeLeft: 240,
      };
      rooms.set(roomId, room);
      ws.roomId = roomId; ws.playerIdx = 0;
      send(ws, { type: 'room_created', roomId, bet: msg.bet });
      console.log(`Room ${roomId} created bet:${msg.bet} SOL wallet:${msg.walletAddress}`);
    }

    else if (msg.type === 'join_room') {
      const room = rooms.get(msg.roomId);
      if (!room) { send(ws, { type: 'error', message: 'Room not found' }); return; }
      if (room.players.length >= 2) { send(ws, { type: 'error', message: 'Room full' }); return; }
      room.players.push({ ws, walletAddress: msg.walletAddress, score: 0 });
      room.status = 'playing';
      ws.roomId = msg.roomId; ws.playerIdx = 1;
      broadcast(room, {
        type: 'game_start', roomId: room.id, bet: room.bet,
        grid: room.grid, turn: 0,
        players: room.players.map((p,i) => ({ idx:i, walletAddress:p.walletAddress }))
      });
      startTimer(room);
      console.log(`Room ${room.id} started`);
    }

    else if (msg.type === 'shot') {
      const room = rooms.get(ws.roomId);
      if (!room || room.turn !== ws.playerIdx) return;
      room.players[ws.playerIdx].score += 1;
      room.turn = room.turn === 0 ? 1 : 0;
      broadcast(room, {
        type: 'shot_result', playerIdx: ws.playerIdx,
        landX: msg.landX, landY: msg.landY,
        scores: room.players.map(p => p.score),
        nextTurn: room.turn,
      });
    }
  });

  ws.on('close', async () => {
    const room = rooms.get(ws.roomId);
    if (!room || room.settled) return;
    const oppIdx = ws.playerIdx === 0 ? 1 : 0;
    if (room.players[oppIdx]) {
      await settleGame(room, oppIdx);
    } else {
      // Player 1 left before anyone joined — refund
      if (room.players[0]?.walletAddress && room.bet > 0) {
        await payWinner(room.players[0].walletAddress, room.bet);
      }
      rooms.delete(room.id);
    }
  });
});

setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) { ws.terminate(); return; }
    ws.isAlive = false; ws.ping();
  });
}, 30000);

server.listen(PORT, () => console.log(`HexShot server on port ${PORT}`));
