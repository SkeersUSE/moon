const socket = io();
const params = new URLSearchParams(location.search);
const roomCode = (params.get('room') || '').toUpperCase();

const roomEl = document.querySelector('#roomCode');
const participants = document.querySelector('#participants');
const statusTitle = document.querySelector('#statusTitle');
const statusText = document.querySelector('#statusText');
const statusLabel = document.querySelector('#statusLabel');
const error = document.querySelector('#error');
const voiceOrb = document.querySelector('#voiceOrb');
const micToggle = document.querySelector('#micToggle');
const remoteToggle = document.querySelector('#remoteToggle');
const noiseToggle = document.querySelector('#noiseToggle');
const micState = document.querySelector('#micState');
const remoteState = document.querySelector('#remoteState');
const microphoneSelect = document.querySelector('#microphoneSelect');
const speakerSelect = document.querySelector('#speakerSelect');
const remoteAudio = document.querySelector('#remoteAudio');
const localAudio = document.querySelector('#localAudio');

const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' }
  ]
};

let joined = false;
let peer = null;
let localStream = null;
let localTrack = null;
let remoteStream = new MediaStream();
let remoteMuted = false;
let micEnabled = true;
let noiseSuppression = true;
let currentMicrophoneId = '';
let leaving = false;

roomEl.textContent = roomCode || '------';
remoteAudio.srcObject = remoteStream;

if (!/^[A-Z2-9]{6}$/.test(roomCode)) {
  showError('Некорректная ссылка на комнату.');
} else {
  socket.emit('room:join', { code: roomCode }, async (res) => {
    if (!res?.ok) {
      showError(res?.error || 'Не удалось войти в комнату.');
      return;
    }
    joined = true;
    await initializeAudio();
  });
}

socket.on('room:state', (state) => {
  if (state.code !== roomCode) return;
  participants.textContent = `${state.count} из 2 участников`;

  if (state.count >= 2) {
    statusTitle.textContent = 'Собеседник подключён';
    statusText.textContent = localStream ? 'Голосовая связь готова.' : 'Разрешите доступ к микрофону, чтобы начать разговор.';
    statusLabel.textContent = 'VOICE SESSION';
    voiceOrb.classList.add('connected');
  } else {
    statusTitle.textContent = 'Ожидание собеседника';
    statusText.textContent = localStream ? 'Отправьте приглашение. Микрофон готов.' : 'Отправьте приглашение и разрешите доступ к микрофону.';
    statusLabel.textContent = 'WAITING';
    voiceOrb.classList.remove('connected');
  }
});

socket.on('webrtc:make-offer', async () => {
  try {
    await ensurePeer();
    const offer = await peer.createOffer({ offerToReceiveAudio: true });
    await peer.setLocalDescription(offer);
    socket.emit('webrtc:offer', peer.localDescription);
  } catch (err) {
    showError(`Не удалось создать аудиосоединение: ${err.message || err}`);
  }
});

socket.on('webrtc:offer', async (offer) => {
  try {
    await ensurePeer();
    await peer.setRemoteDescription(offer);
    const answer = await peer.createAnswer();
    await peer.setLocalDescription(answer);
    socket.emit('webrtc:answer', peer.localDescription);
  } catch (err) {
    showError(`Не удалось принять аудиосоединение: ${err.message || err}`);
  }
});

socket.on('webrtc:answer', async (answer) => {
  try {
    if (!peer) return;
    await peer.setRemoteDescription(answer);
  } catch (err) {
    showError(`Не удалось подтвердить аудиосоединение: ${err.message || err}`);
  }
});

socket.on('webrtc:ice-candidate', async (candidate) => {
  try {
    await ensurePeer();
    if (peer.remoteDescription) await peer.addIceCandidate(candidate);
  } catch (err) {
    console.warn('ICE candidate error', err);
  }
});

socket.on('webrtc:peer-left', () => {
  resetPeer();
  remoteStream = new MediaStream();
  remoteAudio.srcObject = remoteStream;
  statusTitle.textContent = 'Собеседник отключился';
  statusText.textContent = 'Ожидание нового подключения к этой комнате.';
  statusLabel.textContent = 'WAITING';
  voiceOrb.classList.remove('connected');
});

socket.on('connect_error', () => showError('Соединение с сервером потеряно.'));

async function initializeAudio() {
  try {
    await requestMicrophone(currentMicrophoneId);
    await refreshDevices();
    clearError();
  } catch (err) {
    micEnabled = false;
    updateMicUI();
    showError(getMicError(err));
    await refreshDevices().catch(() => {});
  }
}

async function requestMicrophone(deviceId = '') {
  const constraints = {
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      echoCancellation: true,
      noiseSuppression,
      autoGainControl: true
    },
    video: false
  };

  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  const newTrack = stream.getAudioTracks()[0];
  if (!newTrack) throw new Error('Микрофон не найден.');

  const oldStream = localStream;
  localStream = stream;
  localTrack = newTrack;
  localTrack.enabled = micEnabled;
  currentMicrophoneId = newTrack.getSettings().deviceId || deviceId || '';
  localAudio.srcObject = localStream;

  if (peer) {
    const sender = peer.getSenders().find((item) => item.track?.kind === 'audio');
    if (sender) await sender.replaceTrack(localTrack);
  }

  if (oldStream) oldStream.getTracks().forEach((track) => track.stop());
  updateMicUI();
}

async function ensurePeer() {
  if (peer) return peer;
  peer = new RTCPeerConnection(rtcConfig);

  if (localTrack) peer.addTrack(localTrack, localStream);

  peer.ontrack = (event) => {
    const [stream] = event.streams;
    if (stream) {
      remoteStream = stream;
      remoteAudio.srcObject = stream;
      remoteAudio.muted = remoteMuted;
      remoteAudio.play().catch(() => {});
    }
  };

  peer.onicecandidate = (event) => {
    if (event.candidate) socket.emit('webrtc:ice-candidate', event.candidate);
  };

  peer.onconnectionstatechange = () => {
    const state = peer.connectionState;
    if (state === 'connected') {
      statusLabel.textContent = 'CONNECTED';
      statusTitle.textContent = 'Собеседник подключён';
      statusText.textContent = 'Голосовая связь активна.';
      voiceOrb.classList.add('connected');
      clearError();
    } else if (state === 'failed') {
      showError('Не удалось установить прямое соединение. Возможно, нужен TURN-сервер.');
    }
  };

  return peer;
}

function resetPeer() {
  if (!peer) return;
  peer.ontrack = null;
  peer.onicecandidate = null;
  peer.close();
  peer = null;
}

async function refreshDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const devices = await navigator.mediaDevices.enumerateDevices();
  const inputs = devices.filter((device) => device.kind === 'audioinput');
  const outputs = devices.filter((device) => device.kind === 'audiooutput');

  microphoneSelect.innerHTML = '';
  addOption(microphoneSelect, '', 'По умолчанию');
  inputs.forEach((device, index) => addOption(microphoneSelect, device.deviceId, device.label || `Микрофон ${index + 1}`));
  if ([...microphoneSelect.options].some((o) => o.value === currentMicrophoneId)) microphoneSelect.value = currentMicrophoneId;

  speakerSelect.innerHTML = '';
  addOption(speakerSelect, '', 'По умолчанию');
  outputs.forEach((device, index) => addOption(speakerSelect, device.deviceId, device.label || `Динамик ${index + 1}`));
  speakerSelect.disabled = typeof remoteAudio.setSinkId !== 'function';
  if (speakerSelect.disabled) speakerSelect.title = 'Выбор динамика не поддерживается этим браузером.';
}

function addOption(select, value, label) {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = label;
  select.appendChild(option);
}

micToggle.addEventListener('click', () => {
  micEnabled = !micEnabled;
  if (localTrack) localTrack.enabled = micEnabled;
  updateMicUI();
});

remoteToggle.addEventListener('click', () => {
  remoteMuted = !remoteMuted;
  remoteAudio.muted = remoteMuted;
  remoteState.textContent = remoteMuted ? 'Звук выключен' : 'Звук включён';
  remoteToggle.classList.toggle('active', !remoteMuted);
  remoteToggle.classList.toggle('muted', remoteMuted);
});

noiseToggle.addEventListener('change', async () => {
  noiseSuppression = noiseToggle.checked;
  if (!localTrack) return;
  try {
    await localTrack.applyConstraints({
      noiseSuppression,
      echoCancellation: true,
      autoGainControl: true
    });
    clearError();
  } catch (err) {
    showError('Этот браузер не позволяет изменить шумоподавление на лету.');
    noiseToggle.checked = !noiseSuppression;
    noiseSuppression = !noiseSuppression;
  }
});

microphoneSelect.addEventListener('change', async () => {
  try {
    await requestMicrophone(microphoneSelect.value);
    clearError();
    await refreshDevices();
  } catch (err) {
    showError(getMicError(err));
  }
});

speakerSelect.addEventListener('change', async () => {
  if (typeof remoteAudio.setSinkId !== 'function') {
    showError('Выбор динамика не поддерживается этим браузером.');
    return;
  }
  try {
    await remoteAudio.setSinkId(speakerSelect.value || 'default');
    clearError();
  } catch (err) {
    showError('Не удалось выбрать этот динамик.');
  }
});

navigator.mediaDevices?.addEventListener?.('devicechange', () => refreshDevices().catch(() => {}));

function updateMicUI() {
  micState.textContent = micEnabled ? 'Включён' : 'Выключен';
  micToggle.textContent = micEnabled ? 'Микрофон' : 'Без звука';
  micToggle.classList.toggle('active', micEnabled);
  micToggle.classList.toggle('muted', !micEnabled);
}

function getMicError(err) {
  if (err?.name === 'NotAllowedError') return 'Доступ к микрофону запрещён. Разрешите микрофон в настройках браузера.';
  if (err?.name === 'NotFoundError') return 'Микрофон не найден.';
  if (err?.name === 'NotReadableError') return 'Микрофон занят другим приложением.';
  if (location.protocol !== 'https:' && location.hostname !== 'localhost') return 'Для микрофона нужен HTTPS или localhost.';
  return `Не удалось включить микрофон: ${err?.message || err}`;
}

async function copyInvite() {
  const url = `${location.origin}/?room=${encodeURIComponent(roomCode)}`;
  try {
    await navigator.clipboard.writeText(url);
    document.querySelector('#copy').textContent = 'Ссылка скопирована';
    setTimeout(() => document.querySelector('#copy').textContent = 'Скопировать ссылку', 1800);
  } catch {
    showError(`Скопируйте ссылку вручную: ${url}`);
  }
}

document.querySelector('#copy').addEventListener('click', copyInvite);
document.querySelector('#share').addEventListener('click', async () => {
  const url = `${location.origin}/?room=${encodeURIComponent(roomCode)}`;
  if (navigator.share) {
    try { await navigator.share({ title: 'Hush — приглашение', text: 'Присоединитесь к моей комнате Hush.', url }); } catch {}
  } else copyInvite();
});

document.querySelector('#leave').addEventListener('click', () => {
  if (leaving) return;
  leaving = true;
  if (localStream) localStream.getTracks().forEach((track) => track.stop());
  resetPeer();
  if (joined) socket.emit('room:leave', () => location.href = '/');
  else location.href = '/';
});

window.addEventListener('beforeunload', () => {
  if (localStream) localStream.getTracks().forEach((track) => track.stop());
  if (joined) socket.emit('room:leave');
});

function showError(text) { error.textContent = text || ''; }
function clearError() { error.textContent = ''; }

const saved = localStorage.getItem('hush-theme');
if (saved === 'light') document.documentElement.dataset.theme = 'light';
updateMicUI();
