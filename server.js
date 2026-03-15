const WebSocket = require('ws');
const https     = require('https');
const http      = require('http');

const PORT        = process.env.PORT || 3001;
const HOUSE_KEY   = process.env.HOUSE_KEYPAIR;
const HELIUS_RPC  = 'https://mainnet.helius-rpc.com/?api-key=ad3029b1-970c-4f66-a68d-58301f7c0a3a';
const HOUSE_FEE   = 0.10; // 10% house fee
const REFUND_RATE = 0.90; // 90% refund if no opponent

// ── Solana payout ─────────────────────────────
async function sendSolana(toAddress, lamports){
  if (!HOUSE_KEY){ console.log('No HOUSE_KEYPAIR set'); return null; }
  try{
    const bs58    = require('bs58');
    const web3    = require('@solana/web3.js');
    const keypair = web3.Keypair.fromSecretKey(bs58.decode(HOUSE_KEY));
    const conn    = new web3.Connection(HELIUS_RPC, 'confirmed');
    const to      = new web3.PublicKey(toAddress);
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
    const tx = new web3.Transaction();
    tx.recentBlockhash = blockhash;
    tx.feePayer = keypair.publicKey;
    tx.add(web3.SystemProgram.transfer({
      fromPubkey: keypair.publicKey,
      toPubkey: to,
      lamports
    }));
    tx.sign(keypair);
    const sig = await conn.sendRawTransaction(tx.serialize());
    await conn.confirmTransaction({signature:sig, blockhash, lastValidBlockHeight});
    return sig;
  }catch(e){
    console.error('Payout error:', e.message);
    return null;
  }
}

// ── State ─────────────────────────────────────
const rooms   = new Map(); // roomId -> room
const clients = new Map(); // ws -> {roomId, playerIdx, walletAddress}

const server = http.createServer((req,res)=>{
  res.writeHead(200);
  res.end('HexShot backend running');
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws)=>{
  clients.set(ws, {});

  ws.on('message', async(raw)=>{
    let msg;
    try{ msg = JSON.parse(raw); }catch{ return; }
    const client = clients.get(ws);

    if (msg.type==='ping'){ ws.send(JSON.stringify({type:'pong'})); return; }

    // ── Get open rooms list ──────────────────
    if (msg.type==='get_rooms'){
      const openRooms = [];
      for (const [id, room] of rooms){
        if (room.status==='waiting'){
          openRooms.push({
            roomId: id,
            bet: room.bet,
            walletAddress: room.players[0]?.walletAddress||''
          });
        }
      }
      ws.send(JSON.stringify({type:'rooms_list', rooms: openRooms}));
      return;
    }

    // ── Create room ──────────────────────────
    if (msg.type==='create_room'){
      const { bet, walletAddress, roomId, txSig } = msg;
      if (!bet||!walletAddress||!roomId){ ws.send(JSON.stringify({type:'error',message:'Missing fields'})); return; }
      if (rooms.has(roomId)){ ws.send(JSON.stringify({type:'error',message:'Room already exists'})); return; }

      const room = {
        roomId, bet,
        status: 'waiting',
        players: [{ws, walletAddress, score:0}],
        txSigs: [txSig],
        scores: [0,0],
        createdAt: Date.now(),
        // Auto-cancel after 5 min
        cancelTimer: setTimeout(()=> autoCancelRoom(roomId), 5*60*1000)
      };
      rooms.set(roomId, room);
      clients.set(ws, {roomId, playerIdx:0, walletAddress});

      ws.send(JSON.stringify({type:'room_created', roomId}));

      // Broadcast updated rooms list to all waiting clients
      broadcastRoomsList();
      return;
    }

    // ── Cancel room (manual or auto) ─────────
    if (msg.type==='cancel_room'){
      const { roomId } = msg;
      await autoCancelRoom(roomId);
      return;
    }

    // ── Join room ────────────────────────────
    if (msg.type==='join_room'){
      const { roomId, walletAddress, txSig } = msg;
      const room = rooms.get(roomId);
      if (!room){ ws.send(JSON.stringify({type:'error',message:'Room not found'})); return; }
      if (room.status!=='waiting'){ ws.send(JSON.stringify({type:'error',message:'Room is full'})); return; }
      if (room.players[0]?.walletAddress===walletAddress){ ws.send(JSON.stringify({type:'error',message:'Cannot play yourself'})); return; }

      // Cancel auto-cancel timer
      if (room.cancelTimer){ clearTimeout(room.cancelTimer); room.cancelTimer=null; }

      room.players.push({ws, walletAddress, score:0});
      room.txSigs.push(txSig);
      room.status = 'playing';
      clients.set(ws, {roomId, playerIdx:1, walletAddress});

      const startMsg = {
        type: 'game_start',
        roomId,
        bet: room.bet,
        players: room.players.map(p=>({walletAddress:p.walletAddress}))
      };
      room.players.forEach(p=> p.ws.send(JSON.stringify(startMsg)));

      broadcastRoomsList();
      return;
    }

    // ── Game shot ────────────────────────────
    if (msg.type==='shot'){
      const { roomId } = client;
      const room = rooms.get(roomId);
      if (!room||room.status!=='playing') return;
      const idx = client.playerIdx;
      const points = parseInt(msg.points)||0;
      room.scores[idx] = (room.scores[idx]||0) + points;

      const shotMsg = JSON.stringify({type:'shot_result', scores: room.scores});
      room.players.forEach(p=>{ if(p.ws.readyState===WebSocket.OPEN) p.ws.send(shotMsg); });
      return;
    }

    // ── Game end ─────────────────────────────
    if (msg.type==='game_over'){
      const { roomId } = client;
      await settleGame(roomId);
      return;
    }
  });

  ws.on('close', ()=>{
    const client = clients.get(ws);
    if (client?.roomId){
      const room = rooms.get(client.roomId);
      if (room && room.status==='playing'){
        // Player disconnected during game — other player wins
        const winnerIdx = client.playerIdx===0 ? 1 : 0;
        settleGame(client.roomId, winnerIdx);
      }
    }
    clients.delete(ws);
  });
});

// ── Auto-cancel room (no opponent) ───────────
async function autoCancelRoom(roomId){
  const room = rooms.get(roomId);
  if (!room || room.status!=='waiting') return;

  room.status = 'cancelled';
  if (room.cancelTimer){ clearTimeout(room.cancelTimer); room.cancelTimer=null; }

  const player = room.players[0];
  if (!player) { rooms.delete(roomId); return; }

  // Refund 90% to player
  const betLamports = Math.round(room.bet * 1e9);
  const refundLamports = Math.round(betLamports * REFUND_RATE);

  console.log(`Auto-cancelling room ${roomId}, refunding ${refundLamports} lamports to ${player.walletAddress}`);

  const sig = await sendSolana(player.walletAddress, refundLamports);

  if (player.ws.readyState===WebSocket.OPEN){
    player.ws.send(JSON.stringify({
      type: 'refunded',
      amount: (refundLamports/1e9).toFixed(4),
      signature: sig||''
    }));
  }

  rooms.delete(roomId);
  broadcastRoomsList();
}

// ── Settle game ───────────────────────────────
async function settleGame(roomId, forceWinnerIdx=null){
  const room = rooms.get(roomId);
  if (!room) return;

  room.status = 'settled';

  const s = room.scores;
  let winnerIdx = forceWinnerIdx;
  if (winnerIdx===null){
    if (s[0]>s[1]) winnerIdx=0;
    else if (s[1]>s[0]) winnerIdx=1;
    else winnerIdx=null; // draw
  }

  const totalLamports = Math.round(room.bet * 2 * 1e9);
  const houseLamports = Math.round(totalLamports * HOUSE_FEE);
  const payoutLamports = totalLamports - houseLamports;

  if (winnerIdx!==null){
    const winner = room.players[winnerIdx];
    const sig = await sendSolana(winner.walletAddress, payoutLamports);

    const endMsg = {type:'game_end', winner:winnerIdx, scores:s, payout:(payoutLamports/1e9).toFixed(4)};
    room.players.forEach(p=>{ if(p.ws.readyState===WebSocket.OPEN) p.ws.send(JSON.stringify(endMsg)); });

    if (winner.ws.readyState===WebSocket.OPEN){
      winner.ws.send(JSON.stringify({type:'payout_sent', amount:(payoutLamports/1e9).toFixed(4), signature:sig||''}));
    }
  } else {
    // Draw — refund both 90%
    const refundEach = Math.round(room.bet * REFUND_RATE * 1e9);
    for (const p of room.players){
      await sendSolana(p.walletAddress, refundEach);
      if(p.ws.readyState===WebSocket.OPEN){
        p.ws.send(JSON.stringify({type:'game_end', winner:null, scores:s, payout:0}));
        p.ws.send(JSON.stringify({type:'payout_sent', amount:(refundEach/1e9).toFixed(4)}));
      }
    }
  }

  rooms.delete(roomId);
  broadcastRoomsList();
}

// ── Broadcast rooms list to all ───────────────
function broadcastRoomsList(){
  const openRooms = [];
  for (const [id, room] of rooms){
    if (room.status==='waiting'){
      openRooms.push({
        roomId: id,
        bet: room.bet,
        walletAddress: room.players[0]?.walletAddress||''
      });
    }
  }
  const msg = JSON.stringify({type:'rooms_list', rooms:openRooms});
  wss.clients.forEach(c=>{ if(c.readyState===WebSocket.OPEN) c.send(msg); });
}

// ── Timer broadcasts ──────────────────────────
setInterval(()=>{
  for (const [roomId, room] of rooms){
    if (room.status!=='playing') continue;
    if (!room.startTime) room.startTime = Date.now();
    const elapsed = Math.floor((Date.now()-room.startTime)/1000);
    const timeLeft = Math.max(0, 240-elapsed);
    const timerMsg = JSON.stringify({type:'timer', timeLeft});
    room.players.forEach(p=>{ if(p.ws.readyState===WebSocket.OPEN) p.ws.send(timerMsg); });
    if (timeLeft<=0) settleGame(roomId);
  }
}, 1000);

server.listen(PORT, ()=> console.log('HexShot backend running on port', PORT));
