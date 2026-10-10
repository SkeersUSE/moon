const socket = io();
const create = document.querySelector('#create');
const join = document.querySelector('#join');
const code = document.querySelector('#code');
const error = document.querySelector('#error');

autoJoin();
function showError(text) { error.textContent = text || ''; }
function go(code) { location.href = `/call.html?room=${encodeURIComponent(code)}`; }
create.addEventListener('click', () => {
  showError(''); create.disabled = true;
  socket.emit('room:create', (res) => { create.disabled = false; if (res?.ok) go(res.code); else showError(res?.error || 'Не удалось создать комнату.'); });
});
join.addEventListener('click', joinRoom);
code.addEventListener('input', () => { code.value = code.value.replace(/[^a-z0-9]/gi, '').slice(0, 6).toUpperCase(); showError(''); });
code.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom(); });
function joinRoom() {
  showError(''); const value = code.value.trim().toUpperCase();
  if (!/^[A-Z2-9]{6}$/.test(value)) return showError('Введите корректный код из 6 символов.');
  join.disabled = true;
  socket.emit('room:join', { code: value }, (res) => { join.disabled = false; if (res?.ok) go(res.code); else showError(res?.error || 'Не удалось присоединиться.'); });
}
function autoJoin() {
  const params = new URLSearchParams(location.search); const invite = params.get('room');
  if (invite) { code.value = invite.toUpperCase().slice(0, 6); joinRoom(); }
}
const theme = document.querySelector('#theme');
const saved = localStorage.getItem('hush-theme'); if (saved === 'light') document.documentElement.dataset.theme = 'light';
theme.addEventListener('click', () => { const light = document.documentElement.dataset.theme === 'light'; document.documentElement.dataset.theme = light ? '' : 'light'; localStorage.setItem('hush-theme', light ? 'dark' : 'light'); });
