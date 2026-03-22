/**
 * Telegram Proxy для Render.com
 * 
 * Работает как HTTP CONNECT прокси — Telegram поддерживает этот режим.
 * Render даёт бесплатный HTTPS-эндпоинт, через который туннелируется трафик.
 *
 * Переменные окружения (задаются в Render Dashboard → Environment):
 *   PORT        — задаётся Render автоматически
 *   ADMIN_PASS  — пароль для веб-панели (опционально)
 */

const http  = require('http');
const net   = require('net');
const url   = require('url');

const PORT = parseInt(process.env.PORT || '10000');

// ─── Telegram DC серверы ───────────────────────────────────────────────────
const TELEGRAM_DCS = [
  { id: 1, host: '149.154.175.57',  port: 443 },
  { id: 2, host: '149.154.167.51',  port: 443 },
  { id: 3, host: '149.154.175.100', port: 443 },
  { id: 4, host: '149.154.167.91',  port: 443 },
  { id: 5, host: '91.108.56.130',   port: 443 },
];

const ALLOWED_HOSTS = new Set(TELEGRAM_DCS.map(d => d.host));

// ─── Статистика ────────────────────────────────────────────────────────────
const state = {
  startTime:   Date.now(),
  connections: 0,
  active:      0,
  bytesIn:     0,
  bytesOut:    0,
  errors:      0,
  log:         [],
};

const sseClients = new Set();

function addLog(msg, type = 'info') {
  const entry = { time: new Date().toISOString(), msg, type };
  state.log.unshift(entry);
  if (state.log.length > 200) state.log.pop();
  console.log(`[${type.toUpperCase()}] ${entry.time} ${msg}`);
  const data = JSON.stringify(getStats());
  for (const res of sseClients) {
    try { res.write(`data: ${data}\n\n`); } catch (_) {}
  }
}

function getStats() {
  return {
    uptime:      Math.floor((Date.now() - state.startTime) / 1000),
    connections: state.connections,
    active:      state.active,
    bytesIn:     state.bytesIn,
    bytesOut:    state.bytesOut,
    errors:      state.errors,
    log:         state.log.slice(0, 30),
  };
}

// ─── HTTP CONNECT туннель ──────────────────────────────────────────────────
function handleConnect(req, clientSocket, head) {
  let hostname, port;
  if (req.url.includes(':')) {
    [hostname, port] = req.url.split(':');
  } else {
    const p = url.parse(req.url);
    hostname = p.hostname; port = p.port || '443';
  }

  if (!ALLOWED_HOSTS.has(hostname)) {
    addLog(`Отклонён: ${hostname}`, 'warn');
    clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    clientSocket.destroy();
    return;
  }

  state.connections++;
  state.active++;
  addLog(`CONNECT → ${hostname}:${port}`, 'ok');

  const target = net.createConnection({ host: hostname, port: parseInt(port) || 443 }, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length > 0) { target.write(head); state.bytesOut += head.length; }
    target.on('data', d => { state.bytesIn  += d.length; });
    clientSocket.on('data', d => { state.bytesOut += d.length; });
    target.pipe(clientSocket);
    clientSocket.pipe(target);
  });

  const end = (r) => {
    state.active = Math.max(0, state.active - 1);
    addLog(`Закрыт: ${r}`, 'warn');
    clientSocket.destroy(); target.destroy();
  };
  target.on('end',   () => end('DC отключился'));
  clientSocket.on('end',   () => end('клиент отключился'));
  target.on('error', e => { state.errors++; end(`DC err: ${e.message}`); });
  clientSocket.on('error', e => { state.errors++; end(`client err: ${e.message}`); });
}

// ─── HTTP сервер ───────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  if (req.url === '/stats/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*' });
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    res.write(`data: ${JSON.stringify(getStats())}\n\n`);
    return;
  }
  if (req.url === '/health') { res.writeHead(200); res.end('OK'); return; }
  if (req.url === '/stats')  { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(getStats())); return; }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(getHTML());
});

server.on('connect', handleConnect);
server.listen(PORT, '0.0.0.0', () => {
  addLog(`Сервер на порту ${PORT}`, 'ok');
});

function getHTML() { return `<!DOCTYPE html>
<html lang="ru"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Telegram Proxy</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Syne:wght@400;800&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#07090f;--card:#0f1320;--border:#1a2035;--blue:#4f8ef7;--teal:#2dd4bf;--ok:#34d399;--err:#f87171;--warn:#fbbf24;--text:#dde3f0;--muted:#4a5568}
body{background:var(--bg);color:var(--text);font-family:'Space Mono',monospace;min-height:100vh}
body::after{content:'';position:fixed;inset:0;pointer-events:none;background:radial-gradient(ellipse 60% 40% at 80% 20%,rgba(79,142,247,.07) 0%,transparent 60%),radial-gradient(ellipse 50% 50% at 20% 80%,rgba(167,139,250,.05) 0%,transparent 60%)}
header{position:sticky;top:0;z-index:20;padding:18px 28px;display:flex;align-items:center;gap:12px;border-bottom:1px solid var(--border);background:rgba(7,9,15,.88);backdrop-filter:blur(16px)}
.logo{font-family:'Syne',sans-serif;font-weight:800;font-size:1.1rem;color:var(--blue)}
.badge{font-size:.6rem;padding:3px 10px;border-radius:99px;background:var(--blue);color:#000;font-weight:700}
.live{margin-left:auto;display:flex;align-items:center;gap:7px;font-size:.65rem;color:var(--muted)}
.dot{width:7px;height:7px;border-radius:50%;background:var(--ok);box-shadow:0 0 8px var(--ok);animation:blink 2s infinite}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.3}}
main{position:relative;z-index:1;padding:26px;max-width:1000px;margin:0 auto}
.setup{background:var(--card);border:1px solid var(--blue);border-radius:14px;padding:22px;margin-bottom:26px;background-image:linear-gradient(135deg,rgba(79,142,247,.05),transparent)}
.setup-title{font-family:'Syne',sans-serif;font-size:.95rem;font-weight:800;color:var(--blue);margin-bottom:14px}
.steps{display:flex;flex-direction:column;gap:10px}
.step{display:flex;gap:12px;align-items:flex-start;font-size:.74rem}
.sn{min-width:22px;height:22px;border-radius:50%;background:var(--blue);color:#000;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:.68rem;flex-shrink:0}
.st{line-height:1.65}
.code{background:#050710;border:1px solid var(--border);border-radius:7px;padding:10px 14px;font-size:.72rem;color:var(--teal);margin-top:8px;word-break:break-all;position:relative}
.hl{color:var(--blue);font-weight:700}
.copy-btn{position:absolute;right:8px;top:8px;background:var(--blue);border:none;border-radius:5px;color:#000;font-family:inherit;font-size:.6rem;font-weight:700;padding:4px 8px;cursor:pointer;opacity:.85}
.copy-btn:hover{opacity:1}
.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:26px}
.metric{background:var(--card);border:1px solid var(--border);border-radius:11px;padding:16px;transition:border-color .2s,transform .15s}
.metric:hover{border-color:var(--blue);transform:translateY(-2px)}
.ml{font-size:.58rem;color:var(--muted);text-transform:uppercase;letter-spacing:.12em;margin-bottom:7px}
.mv{font-family:'Syne',sans-serif;font-size:1.65rem;font-weight:800;color:var(--blue)}
.mu{font-size:.62rem;color:var(--muted);margin-top:2px}
.log-wrap{background:var(--card);border:1px solid var(--border);border-radius:11px;padding:18px}
.log-title{font-family:'Syne',sans-serif;font-size:.68rem;font-weight:800;color:var(--muted);text-transform:uppercase;letter-spacing:.12em;margin-bottom:12px}
.log-list{display:flex;flex-direction:column;gap:5px;max-height:260px;overflow-y:auto}
.log-list::-webkit-scrollbar{width:3px}
.log-list::-webkit-scrollbar-thumb{background:var(--border)}
.log-entry{display:flex;gap:9px;font-size:.67rem;padding:6px 10px;border-radius:6px}
.log-entry.ok{background:rgba(52,211,153,.06);border-left:2px solid var(--ok)}
.log-entry.err{background:rgba(248,113,113,.06);border-left:2px solid var(--err)}
.log-entry.warn{background:rgba(251,191,36,.06);border-left:2px solid var(--warn)}
.log-entry.info{background:rgba(79,142,247,.05);border-left:2px solid var(--blue)}
.lt{color:var(--muted);white-space:nowrap}.lm{flex:1}
</style></head><body>
<header>
  <div class="logo">TG PROXY</div>
  <div class="badge">render.com</div>
  <div class="live"><span class="dot"></span>live</div>
</header>
<main>
  <div class="setup">
    <div class="setup-title">⚡ Инструкция подключения</div>
    <div class="steps">
      <div class="step"><div class="sn">1</div><div class="st">Открой Telegram → <b>Настройки → Данные и память → Тип соединения → Использовать прокси → Добавить прокси</b></div></div>
      <div class="step"><div class="sn">2</div><div class="st">Выбери тип <b>HTTPS</b> и введи:
        <div class="code">
          Сервер: <span class="hl" id="host-val">загрузка...</span>

          Порт: <span class="hl">443</span>

          Логин / Пароль: <i style="color:var(--muted)">оставь пустыми</i>
          <button class="copy-btn" onclick="copySetup()">копировать</button>
        </div>
      </div></div>
      <div class="step"><div class="sn">3</div><div class="st">Нажми <b>Сохранить → Подключиться</b></div></div>
    </div>
  </div>

  <div class="metrics">
    <div class="metric"><div class="ml">Аптайм</div><div class="mv" id="uptime">—</div><div class="mu">секунд</div></div>
    <div class="metric"><div class="ml">Соединений</div><div class="mv" id="conn">0</div></div>
    <div class="metric"><div class="ml">Активных</div><div class="mv" id="active">0</div></div>
    <div class="metric"><div class="ml">Входящий</div><div class="mv" id="bin">0</div><div class="mu" id="binu">B</div></div>
    <div class="metric"><div class="ml">Исходящий</div><div class="mv" id="bout">0</div><div class="mu" id="boutu">B</div></div>
    <div class="metric"><div class="ml">Ошибки</div><div class="mv" id="errs" style="color:var(--err)">0</div></div>
  </div>

  <div class="log-wrap">
    <div class="log-title">Журнал событий</div>
    <div class="log-list" id="log"></div>
  </div>
</main>
<script>
function fmt(b){if(b<1024)return[b.toFixed(0),'B'];if(b<1048576)return[(b/1024).toFixed(1),'KB'];if(b<1073741824)return[(b/1048576).toFixed(1),'MB'];return[(b/1073741824).toFixed(2),'GB']}
function copySetup(){const h=document.getElementById('host-val').textContent;navigator.clipboard.writeText(h);const btn=document.querySelector('.copy-btn');btn.textContent='✓ скопировано';setTimeout(()=>btn.textContent='копировать',2000)}
function update(d){
  document.getElementById('uptime').textContent=d.uptime;
  document.getElementById('conn').textContent=d.connections;
  document.getElementById('active').textContent=d.active;
  document.getElementById('errs').textContent=d.errors;
  const[bi,bu]=fmt(d.bytesIn),[bo,bou]=fmt(d.bytesOut);
  document.getElementById('bin').textContent=bi;document.getElementById('binu').textContent=bu;
  document.getElementById('bout').textContent=bo;document.getElementById('boutu').textContent=bou;
  document.getElementById('host-val').textContent=location.hostname;
  document.getElementById('log').innerHTML=d.log.map(e=>
    '<div class="log-entry '+e.type+'"><span class="lt">'+e.time.slice(11,19)+'</span><span class="lm">'+e.msg+'</span></div>'
  ).join('');
}
const es=new EventSource('/stats/stream');
es.onmessage=e=>update(JSON.parse(e.data));
</script>
</body></html>`; }
