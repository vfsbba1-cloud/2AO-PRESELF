/**
 * 2AO Selfie Server v3.0
 * - Dashboard (account management)
 * - Selfie page (face-api.js capture → OZ API)
 * - Agent API (event_session_id retrieval)
 */
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ═══ STORAGE ═══
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';
const OZ_HOST = 'web-sdk.prod.cdn.spain.ozforensics.com';
const OZ_TENANT = 'blsinternational';

let accounts = {};   // { username: { password, status, event_session_id, selfie_code, created_at } }
let tokens = {};     // { token: username }

// ═══ AUTH ═══
function authMiddleware(req, res, next) {
    const tk = req.headers['x-auth-token'];
    if (!tk || !tokens[tk]) return res.status(401).json({ ok: false, error: 'Unauthorized' });
    next();
}

// Login
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (username === ADMIN_USER && password === ADMIN_PASS) {
        const token = crypto.randomBytes(32).toString('hex');
        tokens[token] = username;
        return res.json({ ok: true, token });
    }
    res.status(401).json({ ok: false, error: 'Invalid credentials' });
});

// ═══ ACCOUNTS CRUD ═══
app.get('/api/accounts', authMiddleware, (req, res) => {
    const list = Object.entries(accounts).map(([u, d]) => ({
        username: u, password: d.password, status: d.status,
        selfie_code: d.selfie_code, event_session_id: d.event_session_id,
        created_at: d.created_at
    }));
    res.json({ ok: true, total: list.length, accounts: list });
});

app.post('/api/accounts', authMiddleware, (req, res) => {
    const { username, password } = req.body;
    if (!username) return res.status(400).json({ ok: false, error: 'Username required' });
    const code = crypto.randomBytes(4).toString('hex');
    accounts[username] = {
        password: password || '', status: 'pending',
        event_session_id: null, selfie_code: code,
        created_at: new Date().toISOString()
    };
    res.json({ ok: true, username, selfie_code: code });
});

app.delete('/api/accounts/:username', authMiddleware, (req, res) => {
    delete accounts[req.params.username];
    res.json({ ok: true });
});

// Generate selfie link
app.post('/api/accounts/:username/generate-link', authMiddleware, (req, res) => {
    const acc = accounts[req.params.username];
    if (!acc) return res.status(404).json({ ok: false });
    acc.selfie_code = crypto.randomBytes(4).toString('hex');
    acc.status = 'pending';
    acc.event_session_id = null;
    const link = `${req.protocol}://${req.get('host')}/selfie/${acc.selfie_code}`;
    res.json({ ok: true, link, code: acc.selfie_code });
});

// Get selfie result (for Agent extension)
app.get('/api/selfie-result/:username', authMiddleware, (req, res) => {
    const acc = accounts[req.params.username];
    if (!acc) return res.status(404).json({ ok: false });
    res.json({
        ok: true, status: acc.status,
        event_session_id: acc.event_session_id
    });
});

// ═══ OZ API PROXY ═══
function ozRequest(method, path, body, contentType) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: OZ_HOST,
            path: `/${OZ_TENANT}/${path}`,
            method,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Linux; Android 13) Chrome/120.0',
                'Origin': 'https://algeria.blsspainglobal.com',
                'Referer': 'https://algeria.blsspainglobal.com/',
            }
        };
        if (body && contentType) {
            options.headers['Content-Type'] = contentType;
            options.headers['Content-Length'] = Buffer.byteLength(body);
        }
        const req = https.request(options, (resp) => {
            let data = '';
            resp.on('data', c => data += c);
            resp.on('end', () => {
                try { resolve({ status: resp.statusCode, data: JSON.parse(data) }); }
                catch (e) { resolve({ status: resp.statusCode, data: data }); }
            });
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

// Process selfie video - calls OZ API
app.post('/api/process-selfie/:code', express.raw({ type: '*/*', limit: '50mb' }), async (req, res) => {
    // Find account by selfie code
    const code = req.params.code;
    const entry = Object.entries(accounts).find(([u, d]) => d.selfie_code === code);
    if (!entry) return res.status(404).send('invalid');

    const [username, acc] = entry;
    console.log(`[SELFIE] Processing for ${username} (code: ${code})`);

    try {
        // Step 1: Init OZ session
        const initResp = await ozRequest('POST', `init.php?_tenant=${OZ_TENANT}`, null, null);
        console.log('[OZ] init:', JSON.stringify(initResp.data).substring(0, 200));

        if (!initResp.data || !initResp.data.state) {
            console.log('[OZ] Init failed');
            return res.send('error');
        }

        // Step 2: Send video via tm.php
        // The video comes as multipart or raw binary from the client
        const boundary = '----2AOBoundary' + Date.now();
        const videoData = req.body;

        // Build multipart body for tm.php
        let multipart = '';
        multipart += `--${boundary}\r\n`;
        multipart += `Content-Disposition: form-data; name="video"; filename="liveness.webm"\r\n`;
        multipart += `Content-Type: video/webm\r\n\r\n`;

        const bodyParts = [
            Buffer.from(multipart, 'utf-8'),
            Buffer.isBuffer(videoData) ? videoData : Buffer.from(videoData),
            Buffer.from(`\r\n--${boundary}--\r\n`, 'utf-8')
        ];
        const fullBody = Buffer.concat(bodyParts);

        const tmResp = await ozRequest('POST',
            `tm.php?_tenant=${OZ_TENANT}`,
            fullBody,
            `multipart/form-data; boundary=${boundary}`
        );
        console.log('[OZ] tm response:', JSON.stringify(tmResp.data).substring(0, 300));

        // Step 3: Parse result
        // OZ returns event_session_id in the response
        let sessionId = null;
        let status = 'rejected';

        if (typeof tmResp.data === 'object') {
            // Try to extract event_session_id from response
            sessionId = tmResp.data.event_session_id ||
                        tmResp.data.session_id ||
                        tmResp.data.folder_id ||
                        tmResp.data.id ||
                        (tmResp.data.data && tmResp.data.data.event_session_id);

            if (tmResp.data.state === true || tmResp.data.status === 'accepted' || sessionId) {
                status = 'accepted';
            }
        }

        // If we got a session ID, store it
        if (sessionId) {
            acc.event_session_id = sessionId;
            acc.status = 'accepted';
            console.log(`[SELFIE] ✅ ${username} accepted: ${sessionId.substring(0, 30)}...`);
            return res.send('accepted');
        } else {
            // Store raw response for debugging
            acc.status = 'rejected';
            acc.last_oz_response = tmResp.data;
            console.log(`[SELFIE] ❌ ${username} rejected`);
            return res.send('rejected');
        }
    } catch (err) {
        console.error('[SELFIE] Error:', err.message);
        return res.send('error');
    }
});

// ═══ SELFIE PAGE ═══
app.get('/selfie/:code', (req, res) => {
    const code = req.params.code;
    const entry = Object.entries(accounts).find(([u, d]) => d.selfie_code === code);
    if (!entry) return res.status(404).send('Link expired or invalid');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(SELFIE_HTML.replace(/\{\{CODE\}\}/g, code));
});

// ═══ DASHBOARD ═══
app.get('/dashboard', (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(DASHBOARD_HTML);
});

// ═══ HEALTH ═══
app.get('/', (req, res) => res.json({ service: '2AO Selfie', version: '3.0', status: 'running', accounts: Object.keys(accounts).length }));
app.get('/health', (req, res) => res.json({ ok: true }));

// ═══ SELFIE HTML (face-api.js) ═══
const SELFIE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Selfie Verification</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0a0e17;color:#fff;font-family:system-ui;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh}
h2{font-size:20px;margin-bottom:12px;color:#00E676;font-weight:800;letter-spacing:1px}
.video-box{position:relative;width:320px;height:420px;border:3px solid #00E676;border-radius:16px;overflow:hidden;margin-bottom:12px;background:#000}
video{width:100%;height:100%;object-fit:cover}
.oval{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:65%;height:70%;border-radius:50%;border:3px solid rgba(0,230,118,.6)}
#warn{position:absolute;top:10px;left:50%;transform:translateX(-50%);padding:6px 14px;border-radius:8px;font-size:13px;font-weight:700;display:none;z-index:2}
#overlay{position:fixed;inset:0;background:rgba(10,14,23,.92);display:none;flex-direction:column;align-items:center;justify-content:center;z-index:99}
#overlay .spin{width:48px;height:48px;border:4px solid rgba(255,255,255,.1);border-top-color:#00E676;border-radius:50%;animation:sp .8s linear infinite;margin-bottom:16px}
@keyframes sp{to{transform:rotate(360deg)}}
#overlay p{font-size:18px;font-weight:700;color:#00E676}
.footer{font-size:11px;color:#475569;margin-top:8px}
</style>
</head>
<body>
<h2>2AO Selfie Verification</h2>
<div class="video-box">
  <video id="vid" autoplay muted playsinline></video>
  <div class="oval" id="oval"></div>
  <div id="warn"></div>
</div>
<div id="overlay"><div class="spin"></div><p id="ovTxt">Processing selfie...</p></div>
<div class="footer">Powered by 2AO</div>

<script src="https://cdn.jsdelivr.net/npm/@vladmandic/face-api/dist/face-api.min.js"></script>
<script>
const CODE = '{{CODE}}';
const vid = document.getElementById('vid');
const warn = document.getElementById('warn');
const oval = document.getElementById('oval');
const overlay = document.getElementById('overlay');
const ovTxt = document.getElementById('ovTxt');

let stream, recorder, chunks = [], recording = false, frontalStart = null;

async function initCam() {
    stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, facingMode: 'user' }, audio: false
    });
    vid.srcObject = stream;
    await vid.play();
}

function isFrontal(lm) {
    if (!lm) return false;
    const le = lm.getLeftEye(), re = lm.getRightEye(), n = lm.getNose();
    if (!le || !re || !n) return false;
    const dx = n[3].x - (le[0].x + re[3].x) / 2;
    return Math.abs(dx) < 12;
}

function inOval(box) {
    if (!box) return false;
    const vw = vid.videoWidth, vh = vid.videoHeight;
    const cx = vw / 2, cy = vh / 2;
    const r = Math.min(vw, vh) * 0.25;
    const fx = box.x + box.width / 2, fy = box.y + box.height / 2;
    return Math.hypot(fx - cx, fy - cy) < r;
}

async function monitor() {
    const opts = new faceapi.TinyFaceDetectorOptions({ inputSize: 160, scoreThreshold: 0.5 });
    async function loop() {
        if (!vid.videoWidth) return requestAnimationFrame(loop);
        const det = await faceapi.detectSingleFace(vid, opts).withFaceLandmarks();
        if (det && isFrontal(det.landmarks) && inOval(det.detection.box)) {
            showWarn('✅ Perfect! Hold still...', '#10b981');
            oval.style.borderColor = '#00E676';
            if (!frontalStart) frontalStart = Date.now();
            if (!recording && Date.now() - frontalStart > 1500) startRec();
        } else if (det) {
            showWarn('↔ Center your face in the oval', '#f59e0b');
            oval.style.borderColor = 'rgba(245,158,11,.8)';
            frontalStart = null;
        } else {
            showWarn('👤 No face detected', '#ef4444');
            oval.style.borderColor = 'rgba(239,68,68,.6)';
            frontalStart = null;
        }
        if (!recording) requestAnimationFrame(loop);
    }
    loop();
}

function showWarn(txt, bg) {
    warn.style.display = 'block';
    warn.textContent = txt;
    warn.style.background = bg;
    warn.style.color = bg === '#10b981' ? '#000' : '#fff';
}

function startRec() {
    recording = true;
    let mimeType = 'video/webm';
    if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = 'video/mp4';
    recorder = new MediaRecorder(stream, { mimeType });
    chunks = [];
    recorder.ondataavailable = e => chunks.push(e.data);
    recorder.onstop = () => uploadVideo();
    recorder.start();
    setTimeout(() => {
        vid.srcObject = null;
        recorder.stop();
    }, 2500);
}

async function uploadVideo() {
    overlay.style.display = 'flex';
    ovTxt.textContent = 'Processing selfie...';
    const blob = new Blob(chunks, { type: recorder.mimeType });
    const form = new FormData();
    form.append('video', blob, CODE);

    try {
        const resp = await fetch('/api/process-selfie/' + CODE, { method: 'POST', body: blob });
        const result = (await resp.text()).trim().toLowerCase();
        if (result === 'accepted') {
            showResult('✅', 'Selfie Accepted!', '#00E676');
        } else if (result === 'rejected') {
            showResult('❌', 'Selfie Rejected - Please retry', '#ef4444', true);
        } else {
            showResult('⚠️', 'Error - Please retry', '#f59e0b', true);
        }
    } catch (e) {
        showResult('⚠️', 'Upload failed - Check connection', '#f59e0b', true);
    }
    stream.getTracks().forEach(t => t.stop());
}

function showResult(icon, msg, color, retry) {
    document.body.innerHTML = '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;background:#0a0e17;color:' + color + ';text-align:center">' +
        '<div style="font-size:64px;margin-bottom:16px">' + icon + '</div>' +
        '<div style="font-size:22px;font-weight:700">' + msg + '</div>' +
        (retry ? '<button onclick="location.reload()" style="margin-top:20px;padding:10px 24px;background:#00E676;color:#000;border:none;border-radius:8px;font-size:16px;font-weight:700;cursor:pointer">Retry</button>' : '<div style="font-size:14px;opacity:.6;margin-top:10px">You can close this page</div>') +
        '</div>';
}

async function start() {
    await faceapi.nets.tinyFaceDetector.loadFromUri('https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model/');
    await faceapi.nets.faceLandmark68Net.loadFromUri('https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model/');
    await initCam();
    monitor();
}
start();
</script>
</body>
</html>`;

// ═══ DASHBOARD HTML ═══
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>2AO Selfie Dashboard</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0a0e17;color:#e2e8f0;font-family:system-ui}
.login-wrap{display:flex;align-items:center;justify-content:center;min-height:100vh}
.login-box{background:#111827;border:1px solid #1e3a5f;border-radius:16px;padding:32px;width:380px;text-align:center}
.login-box h1{color:#00E676;font-size:28px;font-weight:900;margin-bottom:4px}
.login-box p{color:#64748b;font-size:13px;margin-bottom:20px}
.login-box input{width:100%;padding:12px;background:#0a0e17;border:1px solid #1e3a5f;border-radius:8px;color:#e2e8f0;font-size:14px;margin-bottom:10px;outline:none}
.login-box input:focus{border-color:#00E676}
.btn-green{width:100%;padding:12px;background:linear-gradient(135deg,#00C853,#00E676);color:#000;border:none;border-radius:8px;font-size:15px;font-weight:700;cursor:pointer}
.btn-green:hover{opacity:.9}
#loginErr{color:#ef4444;font-size:12px;margin-top:6px;min-height:18px}

#app{display:none}
.topbar{background:#111827;border-bottom:1px solid #1e3a5f;padding:12px 20px;display:flex;align-items:center;gap:12px}
.topbar h1{font-size:18px;color:#00E676;font-weight:800;flex:1}
.topbar .cnt{background:rgba(0,230,118,.15);color:#00E676;padding:4px 12px;border-radius:6px;font-size:13px;font-weight:700}
.topbar button{padding:6px 14px;border-radius:6px;border:1px solid #1e3a5f;background:#1e293b;color:#e2e8f0;font-size:12px;cursor:pointer}
.toolbar{padding:12px 20px;display:flex;gap:8px;flex-wrap:wrap}
.toolbar button{padding:8px 16px;border-radius:8px;border:none;font-size:13px;font-weight:600;cursor:pointer}
.toolbar .add{background:#00E676;color:#000}
.toolbar .del{background:#ef4444;color:#fff}
.toolbar input{flex:1;min-width:150px;padding:8px 12px;background:#111827;border:1px solid #1e3a5f;border-radius:8px;color:#e2e8f0;font-size:13px;outline:none}

.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px;padding:12px 20px}
.card{background:#111827;border:1px solid #1e3a5f;border-radius:12px;padding:14px;position:relative}
.card .user{font-weight:700;font-size:15px;color:#e2e8f0}
.card .pass{font-size:12px;color:#64748b;margin-top:2px}
.card .badge{display:inline-block;padding:3px 10px;border-radius:6px;font-size:11px;font-weight:700;margin-top:8px}
.b-ok{background:rgba(16,185,129,.15);color:#10b981}
.b-pn{background:rgba(245,158,11,.15);color:#f59e0b}
.b-err{background:rgba(239,68,68,.15);color:#ef4444}
.card .actions{display:flex;gap:6px;margin-top:10px}
.card .actions button{padding:5px 10px;border-radius:6px;border:1px solid #1e3a5f;background:#1e293b;color:#e2e8f0;font-size:11px;cursor:pointer}
.card .actions button:hover{background:#293548}
.card .link{font-size:10px;color:#3b82f6;word-break:break-all;margin-top:6px;cursor:pointer}
.card .sid{font-size:9px;color:#475569;word-break:break-all;margin-top:4px}
.card .cb{position:absolute;top:12px;right:12px}

.modal-bg{position:fixed;inset:0;background:rgba(0,0,0,.6);display:none;align-items:center;justify-content:center;z-index:99}
.modal{background:#111827;border:1px solid #1e3a5f;border-radius:16px;padding:24px;width:360px}
.modal h3{color:#00E676;margin-bottom:12px}
.modal input{width:100%;padding:10px;background:#0a0e17;border:1px solid #1e3a5f;border-radius:8px;color:#e2e8f0;font-size:13px;margin-bottom:8px;outline:none}
.modal .btns{display:flex;gap:8px;margin-top:8px}
.modal .btns button{flex:1;padding:8px;border-radius:8px;border:none;font-size:13px;font-weight:600;cursor:pointer}

.toast{position:fixed;bottom:20px;right:20px;padding:12px 20px;border-radius:8px;font-size:13px;font-weight:600;z-index:999;display:none}
</style>
</head>
<body>

<!-- LOGIN -->
<div class="login-wrap" id="loginWrap">
<div class="login-box">
<h1>2AO SELFIE</h1>
<p>Dashboard v3.0</p>
<input type="text" id="iUser" placeholder="Username" value="admin">
<input type="password" id="iPass" placeholder="Password">
<button class="btn-green" onclick="doLogin()">🔐 Connexion</button>
<div id="loginErr"></div>
</div>
</div>

<!-- APP -->
<div id="app">
<div class="topbar">
<h1>2AO SELFIE</h1>
<span class="cnt" id="totalCnt">0</span>
<button onclick="loadAccounts()">🔄</button>
<button onclick="doLogout()">Logout</button>
</div>
<div class="toolbar">
<button class="add" onclick="showAddModal()">+ New Account</button>
<button class="del" onclick="bulkDelete()">🗑 Delete Selected</button>
<input type="text" id="search" placeholder="🔍 Search..." oninput="filterCards()">
</div>
<div class="grid" id="grid"></div>
</div>

<!-- ADD MODAL -->
<div class="modal-bg" id="modalBg">
<div class="modal">
<h3>New Account</h3>
<input id="mUser" placeholder="Username (BLS email)">
<input id="mPass" placeholder="Password">
<div class="btns">
<button style="background:#1e293b;color:#e2e8f0" onclick="closeModal()">Cancel</button>
<button style="background:#00E676;color:#000" onclick="addAccount()">Add</button>
</div>
</div>
</div>

<div class="toast" id="toast"></div>

<script>
const API = window.location.origin;
let TOKEN = localStorage.getItem('2ao_token') || '';

async function api(method, path, body) {
    try {
        const opts = { method, headers: { 'Content-Type': 'application/json', 'X-Auth-Token': TOKEN } };
        if (body) opts.body = JSON.stringify(body);
        const r = await fetch(API + path, opts);
        return await r.json();
    } catch(e) {
        console.error('API Error:', e);
        return { ok: false, error: e.message };
    }
}

async function doLogin() {
    var err = document.getElementById('loginErr');
    err.textContent = 'Connexion...';
    err.style.color = '#f59e0b';
    try {
        const u = document.getElementById('iUser').value.trim();
        const p = document.getElementById('iPass').value;
        if (!u || !p) { err.textContent = 'Remplissez les champs'; err.style.color = '#ef4444'; return; }
        const d = await api('POST', '/api/login', { username: u, password: p });
        if (d.ok) {
            TOKEN = d.token;
            localStorage.setItem('2ao_token', TOKEN);
            document.getElementById('loginWrap').style.display = 'none';
            document.getElementById('app').style.display = 'block';
            loadAccounts();
        } else {
            err.textContent = d.error || 'Identifiants incorrects';
            err.style.color = '#ef4444';
        }
    } catch(e) {
        err.textContent = 'Erreur: ' + e.message;
        err.style.color = '#ef4444';
    }
}

function doLogout() {
    TOKEN = '';
    localStorage.removeItem('2ao_token');
    location.reload();
}

async function loadAccounts() {
    const d = await api('GET', '/api/accounts');
    if (!d.ok) { doLogout(); return; }
    document.getElementById('totalCnt').textContent = d.total;
    const grid = document.getElementById('grid');
    grid.innerHTML = '';
    d.accounts.forEach(a => {
        const link = API + '/selfie/' + a.selfie_code;
        const badge = a.status === 'accepted' ? '<span class="badge b-ok">Accepted ✅</span>' :
                      a.status === 'rejected' ? '<span class="badge b-err">Rejected ❌</span>' :
                      '<span class="badge b-pn">Pending ⏳</span>';
        const sid = a.event_session_id ? '<div class="sid">ID: ' + a.event_session_id.substring(0, 40) + '...</div>' : '';
        grid.innerHTML += '<div class="card" data-user="' + a.username + '">' +
            '<input type="checkbox" class="cb" data-u="' + a.username + '">' +
            '<div class="user">' + a.username + '</div>' +
            '<div class="pass">🔑 ' + (a.password || '—') + '</div>' +
            badge + sid +
            '<div class="link" onclick="copyLink(this)" title="Click to copy">' + link + '</div>' +
            '<div class="actions">' +
            '<button onclick="genLink(&apos;' + a.username + '&apos;)">🔗 New Link</button>' +
            '<button onclick="delAccount(&apos;' + a.username + '&apos;)">🗑</button>' +
            '</div></div>';
    });
}

function copyLink(el) {
    navigator.clipboard.writeText(el.textContent);
    toast('Link copied!', '#10b981');
}

async function genLink(user) {
    const d = await api('POST', '/api/accounts/' + encodeURIComponent(user) + '/generate-link');
    if (d.ok) { toast('New link: ' + d.link, '#3b82f6'); loadAccounts(); }
}

async function delAccount(user) {
    if (!confirm('Delete ' + user + '?')) return;
    await api('DELETE', '/api/accounts/' + encodeURIComponent(user));
    loadAccounts();
}

async function bulkDelete() {
    const cbs = document.querySelectorAll('.cb:checked');
    if (!cbs.length) return;
    if (!confirm('Delete ' + cbs.length + ' accounts?')) return;
    for (const cb of cbs) await api('DELETE', '/api/accounts/' + encodeURIComponent(cb.dataset.u));
    loadAccounts();
}

function showAddModal() { document.getElementById('modalBg').style.display = 'flex'; }
function closeModal() { document.getElementById('modalBg').style.display = 'none'; }

async function addAccount() {
    const u = document.getElementById('mUser').value.trim();
    const p = document.getElementById('mPass').value;
    if (!u) return;
    await api('POST', '/api/accounts', { username: u, password: p });
    closeModal();
    document.getElementById('mUser').value = '';
    document.getElementById('mPass').value = '';
    loadAccounts();
}

function filterCards() {
    const q = document.getElementById('search').value.toLowerCase();
    document.querySelectorAll('.card').forEach(c => {
        c.style.display = c.dataset.user.toLowerCase().includes(q) ? '' : 'none';
    });
}

function toast(msg, bg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.style.background = bg;
    t.style.color = '#fff';
    t.style.display = 'block';
    setTimeout(() => t.style.display = 'none', 3000);
}

// Auto-login
if (TOKEN) {
    api('GET', '/api/accounts').then(d => {
        if (d.ok) {
            document.getElementById('loginWrap').style.display = 'none';
            document.getElementById('app').style.display = 'block';
            loadAccounts();
        }
    });
}
document.getElementById('iPass').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
</script>
</body>
</html>`;

app.listen(PORT, () => console.log(`\n🔥 2AO Selfie Server v3.0\n   Port: ${PORT}\n   Dashboard: /dashboard\n   Ready!\n`));
