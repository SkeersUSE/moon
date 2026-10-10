const path = require('path');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const helmet = require('helmet');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT) || 3000;
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: false } });
const rooms = new Map();
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'hush' }));

function createCode() {
  let code;
  do {
    const bytes = crypto.randomBytes(CODE_LENGTH);
    code = [...bytes].map((b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
  } while (rooms.has(code));
  return code;
}

function normalizeCode(value) {
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

function validCode(code) {
  return /^[A-Z2-9]{6}$/.test(code);
}

function roomState(code) {
  const room = rooms.get(code);
  return { code, count: room ? room.sockets.size : 0, max: 2 };
}

function broadcastState(code) {
  io.to(code).emit('room:state', roomState(code));
}

function relayToRoom(socket, event, payload) {
  const code = socket.data.roomCode;
  if (!code || !rooms.has(code)) return;
  socket.to(code).emit(event, payload);
}

io.on('connection', (socket) => {
  socket.on('room:create', (ack) => {
    if (typeof ack !== 'function') return;
    if (socket.data.roomCode) return ack({ ok: false, error: 'Вы уже находитесь в комнате.' });

    const code = createCode();
    rooms.set(code, { sockets: new Set([socket.id]), createdAt: Date.now() });
    socket.data.roomCode = code;
    socket.join(code);
    ack({ ok: true, code });
    broadcastState(code);
  });

  socket.on('room:join', (payload, ack) => {
    if (typeof ack !== 'function') return;
    if (socket.data.roomCode) return ack({ ok: false, error: 'Вы уже находитесь в комнате.' });

    const code = normalizeCode(payload?.code);
    if (!validCode(code)) return ack({ ok: false, error: 'Код должен состоять из 6 символов.' });

    const room = rooms.get(code);
    if (!room) return ack({ ok: false, error: 'Комната не найдена или уже закрыта.' });
    if (room.sockets.size >= 2) return ack({ ok: false, error: 'Комната уже заполнена.' });

    room.sockets.add(socket.id);
    socket.data.roomCode = code;
    socket.join(code);
    ack({ ok: true, code });
    broadcastState(code);

    // The first participant becomes the WebRTC offerer.
    const [firstSocketId] = [...room.sockets];
    if (firstSocketId) {
      io.to(firstSocketId).emit('webrtc:make-offer');
    }
  });

  socket.on('webrtc:offer', (offer) => {
    if (!offer || typeof offer !== 'object') return;
    relayToRoom(socket, 'webrtc:offer', offer);
  });

  socket.on('webrtc:answer', (answer) => {
    if (!answer || typeof answer !== 'object') return;
    relayToRoom(socket, 'webrtc:answer', answer);
  });

  socket.on('webrtc:ice-candidate', (candidate) => {
    if (!candidate || typeof candidate !== 'object') return;
    relayToRoom(socket, 'webrtc:ice-candidate', candidate);
  });

  socket.on('room:leave', (ack) => {
    leaveRoom(socket);
    if (typeof ack === 'function') ack({ ok: true });
  });

  socket.on('disconnect', () => leaveRoom(socket));
});

function leaveRoom(socket) {
  const code = socket.data.roomCode;
  if (!code) return;

  const room = rooms.get(code);
  socket.data.roomCode = undefined;
  socket.leave(code);
  if (!room) return;

  room.sockets.delete(socket.id);
  if (room.sockets.size === 0) {
    rooms.delete(code);
  } else {
    io.to(code).emit('webrtc:peer-left');
    broadcastState(code);
  }
}

server.listen(PORT, () => console.log(`Hush running at http://localhost:${PORT}`));
