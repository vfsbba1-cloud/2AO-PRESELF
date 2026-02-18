const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Video storage
const VIDEOS_DIR = path.join(__dirname, 'videos');
if (!fs.existsSync(VIDEOS_DIR)) fs.mkdirSync(VIDEOS_DIR);
const upload = multer({ dest: VIDEOS_DIR, limits: { fileSize: 50 * 1024 * 1024 } });

// ═══ CONFIG ═══
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';

let accounts = {};
let tokens = {};

// ═══ AUTH ═══
function auth(req, res, next) {
    const tk = req.headers['x-auth-token'];
    if (!tk || !tokens[tk]) return res.status(401).json({ ok: false, error: 'Unauthorized' });
    next();
}

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (username === ADMIN_USER && password === ADMIN_PASS) {
        const token = crypto.randomBytes(32).toString('hex');
        tokens[token] = username;
        return res.json({ ok: true, token });
    }
    res.status(401).json({ ok: false, error: 'Invalid credentials' });
});

// ═══ ACCOUNTS ═══
app.get('/api/accounts', auth, (req, res) => {
    const list = Object.entries(accounts).map(([u, d]) => ({
        username: u, password: d.password, status: d.status,
        selfie_code: d.selfie_code, has_video: !!d.video_path,
        event_session_id: d.event_session_id, created_at: d.created_at
    }));
    res.json({ ok: true, total: list.length, accounts: list });
});

app.post('/api/accounts', auth, (req, res) => {
    const { username, password } = req.body;
    if (!username) return res.status(400).json({ ok: false, error: 'Username required' });
    const code = crypto.randomBytes(4).toString('hex');
    accounts[username] = {
        password: password || '', status: 'pending',
        event_session_id: null, selfie_code: code,
        video_path: null, video_mime: null,
        created_at: new Date().toISOString()
    };
    res.json({ ok: true, username, selfie_code: code });
});

app.delete('/api/accounts/:username', auth, (req, res) => {
    const acc = accounts[req.params.username];
    if (acc && acc.video_path) {
        try { fs.unlinkSync(acc.video_path); } catch (e) {}
    }
    delete accounts[req.params.username];
    res.json({ ok: true });
});

app.post('/api/accounts/:username/generate-link', auth, (req, res) => {
    const acc = accounts[req.params.username];
    if (!acc) return res.status(404).json({ ok: false });
    acc.selfie_code = crypto.randomBytes(4).toString('hex');
    acc.status = 'pending';
    acc.event_session_id = null;
    if (acc.video_path) { try { fs.unlinkSync(acc.video_path); } catch (e) {} }
    acc.video_path = null;
    const link = req.protocol + '://' + req.get('host') + '/selfie/' + acc.selfie_code;
    res.json({ ok: true, link, code: acc.selfie_code });
});

// ═══ SELFIE PAGE ═══
app.get('/selfie/:code', (req, res) => {
    const entry = Object.entries(accounts).find(([u, d]) => d.selfie_code === req.params.code);
    if (!entry) return res.status(404).send('Link invalid or expired');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(getSelfieHTML(req.params.code));
});

// ═══ VIDEO UPLOAD (from selfie page) ═══
app.post('/api/upload-selfie/:code', upload.single('video'), (req, res) => {
    const code = req.params.code;
    const entry = Object.entries(accounts).find(([u, d]) => d.selfie_code === code);
    if (!entry) { if (req.file) fs.unlinkSync(req.file.path); return res.status(404).json({ ok: false }); }

    const [username, acc] = entry;
    // Remove old video
    if (acc.video_path) { try { fs.unlinkSync(acc.video_path); } catch (e) {} }

    // Save new
    const ext = req.file.mimetype === 'video/mp4' ? '.mp4' : '.webm';
    const newPath = path.join(VIDEOS_DIR, code + ext);
    fs.renameSync(req.file.path, newPath);

    acc.video_path = newPath;
    acc.video_mime = req.file.mimetype;
    acc.status = 'video_ready';
    console.log('[SELFIE] Video saved for ' + username + ' (' + (req.file.size / 1024).toFixed(1) + 'KB)');
    res.json({ ok: true, status: 'video_ready' });
});

// ═══ AGENT API ═══
// Get account status + check if video ready
app.get('/api/agent/status/:username', auth, (req, res) => {
    const acc = accounts[req.params.username];
    if (!acc) return res.status(404).json({ ok: false });
    res.json({
        ok: true, status: acc.status,
        has_video: !!acc.video_path,
        event_session_id: acc.event_session_id
    });
});

// Download video for webcam injection
app.get('/api/agent/video/:username', auth, (req, res) => {
    const acc = accounts[req.params.username];
    if (!acc || !acc.video_path) return res.status(404).json({ ok: false });
    res.setHeader('Content-Type', acc.video_mime || 'video/webm');
    res.sendFile(acc.video_path);
});

// Agent reports the event_session_id after OZ SDK completes
app.post('/api/agent/report-session', auth, (req, res) => {
    const { username, event_session_id } = req.body;
    const acc = accounts[username];
    if (!acc) return res.status(404).json({ ok: false });
    acc.event_session_id = event_session_id;
    acc.status = 'accepted';
    console.log('[AGENT] Session ID for ' + username + ': ' + event_session_id);
    res.json({ ok: true });
});

// ═══ HEALTH ═══
app.get('/', (req, res) => res.json({
    service: '2AO Selfie', version: '4.0', status: 'running',
    accounts: Object.keys(accounts).length
}));

// ═══ DASHBOARD ═══
app.get('/dashboard', (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(getDashboardHTML());
});

// ═══ HTML GENERATORS ═══
function getSelfieHTML(code) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Selfie Verification</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0a0e17;color:#fff;font-family:system-ui;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;padding:16px}
h2{font-size:18px;margin-bottom:10px;color:#00E676;font-weight:800}
.video-box{position:relative;width:300px;height:400px;border:3px solid #00E676;border-radius:16px;overflow:hidden;margin-bottom:10px;background:#000}
video{width:100%;height:100%;object-fit:cover;transform:scaleX(-1)}
.oval{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:60%;height:65%;border-radius:50%;border:3px dashed rgba(0,230,118,.5)}
#status{text-align:center;padding:8px 16px;border-radius:8px;font-size:14px;font-weight:700;margin-bottom:8px;min-height:36px;display:flex;align-items:center;justify-content:center;gap:6px}
#overlay{position:fixed;inset:0;background:rgba(10,14,23,.95);display:none;flex-direction:column;align-items:center;justify-content:center;z-index:99}
#overlay .spin{width:48px;height:48px;border:4px solid rgba(255,255,255,.1);border-top-color:#00E676;border-radius:50%;animation:sp .7s linear infinite;margin-bottom:14px}
@keyframes sp{to{transform:rotate(360deg)}}
.result{display:none;flex-direction:column;align-items:center;justify-content:center;text-align:center;min-height:100vh;gap:12px}
.result .icon{font-size:72px}
.result .msg{font-size:20px;font-weight:700}
.result button{padding:12px 28px;background:#00E676;color:#000;border:none;border-radius:8px;font-size:15px;font-weight:700;cursor:pointer}
</style>
</head>
<body>
<h2>2AO Selfie</h2>
<div id="camera-view">
  <div class="video-box">
    <video id="vid" autoplay muted playsinline></video>
    <div class="oval" id="oval"></div>
  </div>
  <div id="status">Chargement...</div>
</div>
<div id="overlay"><div class="spin"></div><p style="color:#00E676;font-weight:700">Upload en cours...</p></div>
<div class="result" id="resultOk"><div class="icon">&#10004;&#65039;</div><div class="msg" style="color:#00E676">Selfie enregistr&eacute; !</div><div style="color:#94a3b8;font-size:13px">Vous pouvez fermer cette page</div></div>
<div class="result" id="resultFail"><div class="icon">&#10060;</div><div class="msg" style="color:#ef4444">Echec - R&eacute;essayez</div><button onclick="location.reload()">R&eacute;essayer</button></div>

<script src="https://cdn.jsdelivr.net/npm/@vladmandic/face-api/dist/face-api.min.js"></script>
<script>
var CODE='${code}',vid=document.getElementById('vid'),status=document.getElementById('status'),oval=document.getElementById('oval'),overlay=document.getElementById('overlay'),stream,recording=false,frontalStart=null;

function setStatus(txt,bg){status.textContent=txt;status.style.background=bg;status.style.color=bg==='#10b981'?'#000':'#fff'}

async function init(){
  setStatus('Chargement mod\\u00e8les...','#1e293b');
  await faceapi.nets.tinyFaceDetector.loadFromUri('https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model/');
  await faceapi.nets.faceLandmark68Net.loadFromUri('https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model/');
  setStatus('Activation cam\\u00e9ra...','#1e293b');
  stream=await navigator.mediaDevices.getUserMedia({video:{width:640,height:480,facingMode:'user'},audio:false});
  vid.srcObject=stream;
  await vid.play();
  setStatus('Centrez votre visage dans l\\'ovale','#1e293b');
  detect();
}

function isFrontal(lm){
  if(!lm)return false;
  var le=lm.getLeftEye(),re=lm.getRightEye(),n=lm.getNose();
  if(!le||!re||!n||!n[3])return false;
  return Math.abs(n[3].x-(le[0].x+re[3].x)/2)<12;
}

function inOval(box){
  if(!box)return false;
  var vw=vid.videoWidth,vh=vid.videoHeight,cx=vw/2,cy=vh/2,r=Math.min(vw,vh)*0.25;
  return Math.hypot(box.x+box.width/2-cx,box.y+box.height/2-cy)<r;
}

async function detect(){
  var opts=new faceapi.TinyFaceDetectorOptions({inputSize:160,scoreThreshold:0.5});
  async function loop(){
    if(!vid.videoWidth||recording){return}
    var det=await faceapi.detectSingleFace(vid,opts).withFaceLandmarks();
    if(det&&isFrontal(det.landmarks)&&inOval(det.detection.box)){
      setStatus('\\u2705 Parfait ! Ne bougez pas...','#10b981');
      oval.style.borderColor='#00E676';
      if(!frontalStart)frontalStart=Date.now();
      if(Date.now()-frontalStart>1500)return startRec();
    }else if(det){
      setStatus('\\u2194\\uFE0F Centrez votre visage','#f59e0b');
      oval.style.borderColor='rgba(245,158,11,.8)';
      frontalStart=null;
    }else{
      setStatus('\\uD83D\\uDC64 Aucun visage d\\u00e9tect\\u00e9','#ef4444');
      oval.style.borderColor='rgba(239,68,68,.6)';
      frontalStart=null;
    }
    requestAnimationFrame(loop);
  }
  loop();
}

function startRec(){
  recording=true;
  setStatus('\\uD83D\\uDD34 Enregistrement...','#dc2626');
  var mime=MediaRecorder.isTypeSupported('video/webm;codecs=vp8')?'video/webm;codecs=vp8':'video/mp4';
  var rec=new MediaRecorder(stream,{mimeType:mime});
  var chunks=[];
  rec.ondataavailable=function(e){chunks.push(e.data)};
  rec.onstop=function(){uploadVideo(new Blob(chunks,{type:mime}),mime)};
  rec.start();
  setTimeout(function(){rec.stop()},2500);
}

async function uploadVideo(blob,mime){
  document.getElementById('camera-view').style.display='none';
  overlay.style.display='flex';
  stream.getTracks().forEach(function(t){t.stop()});
  var form=new FormData();
  var ext=mime.includes('mp4')?'.mp4':'.webm';
  form.append('video',blob,CODE+ext);
  try{
    var r=await fetch('/api/upload-selfie/'+CODE,{method:'POST',body:form});
    var d=await r.json();
    overlay.style.display='none';
    if(d.ok){document.getElementById('resultOk').style.display='flex'}
    else{document.getElementById('resultFail').style.display='flex'}
  }catch(e){
    overlay.style.display='none';
    document.getElementById('resultFail').style.display='flex';
  }
}

init().catch(function(e){setStatus('Erreur: '+e.message,'#ef4444')});
</script>
</body>
</html>`;
}

function getDashboardHTML() {
    return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>2AO Dashboard</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0a0e17;color:#e2e8f0;font-family:system-ui}
.login-wrap{display:flex;align-items:center;justify-content:center;min-height:100vh}
.login-box{background:#111827;border:1px solid #1e3a5f;border-radius:16px;padding:32px;width:380px;text-align:center}
.login-box h1{color:#00E676;font-size:28px;font-weight:900;margin-bottom:4px}
.login-box p{color:#64748b;font-size:13px;margin-bottom:20px}
.login-box input{width:100%;padding:12px;background:#0a0e17;border:1px solid #1e3a5f;border-radius:8px;color:#e2e8f0;font-size:14px;margin-bottom:10px;outline:none}
.btn-green{width:100%;padding:12px;background:linear-gradient(135deg,#00C853,#00E676);color:#000;border:none;border-radius:8px;font-size:15px;font-weight:700;cursor:pointer}
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
.card .user{font-weight:700;font-size:15px}
.card .pass{font-size:12px;color:#64748b;margin-top:2px}
.badge{display:inline-block;padding:3px 10px;border-radius:6px;font-size:11px;font-weight:700;margin-top:8px}
.b-ok{background:rgba(16,185,129,.15);color:#10b981}
.b-vid{background:rgba(59,130,246,.15);color:#3b82f6}
.b-pn{background:rgba(245,158,11,.15);color:#f59e0b}
.card .actions{display:flex;gap:6px;margin-top:10px;flex-wrap:wrap}
.card .actions button{padding:5px 10px;border-radius:6px;border:1px solid #1e3a5f;background:#1e293b;color:#e2e8f0;font-size:11px;cursor:pointer}
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
<div class="login-wrap" id="loginWrap">
<div class="login-box">
<h1>2AO SELFIE</h1><p>Dashboard v4.0</p>
<input type="text" id="iUser" placeholder="Username" value="admin">
<input type="password" id="iPass" placeholder="Password">
<button class="btn-green" onclick="doLogin()">Connexion</button>
<div id="loginErr"></div>
</div></div>
<div id="app">
<div class="topbar"><h1>2AO SELFIE v4</h1><span class="cnt" id="totalCnt">0</span><button onclick="loadAccounts()">Refresh</button><button onclick="doLogout()">Logout</button></div>
<div class="toolbar">
<button class="add" onclick="showAdd()">+ Nouveau compte</button>
<button class="del" onclick="bulkDel()">Supprimer</button>
<input type="text" id="search" placeholder="Rechercher..." oninput="filterCards()">
</div>
<div class="grid" id="grid"></div>
</div>
<div class="modal-bg" id="modalBg"><div class="modal"><h3>Nouveau compte</h3>
<input id="mUser" placeholder="Email BLS"><input id="mPass" placeholder="Mot de passe">
<div class="btns"><button style="background:#1e293b;color:#e2e8f0" onclick="closeModal()">Annuler</button><button style="background:#00E676;color:#000" onclick="addAccount()">Ajouter</button></div>
</div></div>
<div class="toast" id="toast"></div>
<script>
var API=location.origin,TOKEN=localStorage.getItem('2ao_tk')||'';
async function api(m,p,b){try{var o={method:m,headers:{'Content-Type':'application/json','X-Auth-Token':TOKEN}};if(b)o.body=JSON.stringify(b);var r=await fetch(API+p,o);return await r.json()}catch(e){return{ok:false,error:e.message}}}
async function doLogin(){var err=document.getElementById('loginErr');err.textContent='Connexion...';err.style.color='#f59e0b';try{var u=document.getElementById('iUser').value.trim(),p=document.getElementById('iPass').value;if(!u||!p){err.textContent='Remplissez les champs';err.style.color='#ef4444';return}var d=await api('POST','/api/login',{username:u,password:p});if(d.ok){TOKEN=d.token;localStorage.setItem('2ao_tk',TOKEN);document.getElementById('loginWrap').style.display='none';document.getElementById('app').style.display='block';loadAccounts()}else{err.textContent=d.error||'Erreur';err.style.color='#ef4444'}}catch(e){err.textContent='Erreur: '+e.message;err.style.color='#ef4444'}}
function doLogout(){TOKEN='';localStorage.removeItem('2ao_tk');location.reload()}
async function loadAccounts(){var d=await api('GET','/api/accounts');if(!d.ok){doLogout();return}document.getElementById('totalCnt').textContent=d.total;var g=document.getElementById('grid');g.innerHTML='';d.accounts.forEach(function(a){var link=API+'/selfie/'+a.selfie_code;var badge=a.status==='accepted'?'<span class="badge b-ok">Accepted</span>':a.status==='video_ready'?'<span class="badge b-vid">Video Ready</span>':'<span class="badge b-pn">Pending</span>';var sid=a.event_session_id?'<div class="sid">ID: '+a.event_session_id+'</div>':'';g.innerHTML+='<div class="card" data-user="'+a.username+'"><input type="checkbox" class="cb" data-u="'+a.username+'"><div class="user">'+a.username+'</div><div class="pass">'+a.password+'</div>'+badge+sid+'<div class="link" onclick="copyTxt(this)" title="Cliquer pour copier">'+link+'</div><div class="actions"><button onclick="genLink(&apos;'+a.username+'&apos;)">New Link</button><button onclick="delAcc(&apos;'+a.username+'&apos;)">Supprimer</button></div></div>'})}
function copyTxt(el){navigator.clipboard.writeText(el.textContent);toast('Lien copie!','#10b981')}
async function genLink(u){var d=await api('POST','/api/accounts/'+encodeURIComponent(u)+'/generate-link');if(d.ok){toast('Nouveau lien genere','#3b82f6');loadAccounts()}}
async function delAcc(u){if(!confirm('Supprimer '+u+'?'))return;await api('DELETE','/api/accounts/'+encodeURIComponent(u));loadAccounts()}
async function bulkDel(){var cbs=document.querySelectorAll('.cb:checked');if(!cbs.length)return;if(!confirm('Supprimer '+cbs.length+' comptes?'))return;for(var i=0;i<cbs.length;i++)await api('DELETE','/api/accounts/'+encodeURIComponent(cbs[i].dataset.u));loadAccounts()}
function showAdd(){document.getElementById('modalBg').style.display='flex'}
function closeModal(){document.getElementById('modalBg').style.display='none'}
async function addAccount(){var u=document.getElementById('mUser').value.trim(),p=document.getElementById('mPass').value;if(!u)return;await api('POST','/api/accounts',{username:u,password:p});closeModal();document.getElementById('mUser').value='';document.getElementById('mPass').value='';loadAccounts()}
function filterCards(){var q=document.getElementById('search').value.toLowerCase();document.querySelectorAll('.card').forEach(function(c){c.style.display=c.dataset.user.toLowerCase().includes(q)?'':'none'})}
function toast(msg,bg){var t=document.getElementById('toast');t.textContent=msg;t.style.background=bg;t.style.color='#fff';t.style.display='block';setTimeout(function(){t.style.display='none'},3000)}
if(TOKEN)api('GET','/api/accounts').then(function(d){if(d.ok){document.getElementById('loginWrap').style.display='none';document.getElementById('app').style.display='block';loadAccounts()}});
document.getElementById('iPass').addEventListener('keydown',function(e){if(e.key==='Enter')doLogin()});
</script>
</body></html>`;
}

app.listen(PORT, () => console.log('\n  2AO Selfie Server v4.0\n  Port: ' + PORT + '\n  Dashboard: /dashboard\n  Ready!\n'));
