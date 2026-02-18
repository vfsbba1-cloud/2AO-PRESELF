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

const VIDEOS_DIR = path.join(__dirname, 'videos');
const DATA_FILE = path.join(__dirname, 'data.json');
if (!fs.existsSync(VIDEOS_DIR)) fs.mkdirSync(VIDEOS_DIR);

const upload = multer({ dest: VIDEOS_DIR, limits: { fileSize: 50 * 1024 * 1024 } });

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';

let tokens = {};

// ═══ PERSISTENCE ═══
function loadData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
        }
    } catch (e) { console.log('[DATA] Load error:', e.message); }
    return {};
}
function saveData(accounts) {
    try { fs.writeFileSync(DATA_FILE, JSON.stringify(accounts, null, 2)); }
    catch (e) { console.log('[DATA] Save error:', e.message); }
}
let accounts = loadData();
console.log('[DATA] Loaded ' + Object.keys(accounts).length + ' accounts');

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
    saveData(accounts);
    res.json({ ok: true, username, selfie_code: code });
});

app.delete('/api/accounts/:username', auth, (req, res) => {
    const acc = accounts[req.params.username];
    if (acc && acc.video_path) { try { fs.unlinkSync(acc.video_path); } catch (e) {} }
    delete accounts[req.params.username];
    saveData(accounts);
    res.json({ ok: true });
});

app.post('/api/accounts/:username/generate-link', auth, (req, res) => {
    const acc = accounts[req.params.username];
    if (!acc) return res.status(404).json({ ok: false });
    acc.selfie_code = crypto.randomBytes(4).toString('hex');
    acc.status = 'pending'; acc.event_session_id = null;
    if (acc.video_path) { try { fs.unlinkSync(acc.video_path); } catch (e) {} }
    acc.video_path = null;
    saveData(accounts);
    const link = req.protocol + '://' + req.get('host') + '/selfie/' + acc.selfie_code;
    res.json({ ok: true, link, code: acc.selfie_code });
});

// ═══ SELFIE PAGE ═══
app.get('/selfie/:code', (req, res) => {
    const entry = Object.entries(accounts).find(([u, d]) => d.selfie_code === req.params.code);
    if (!entry) return res.status(404).send('<h1>Lien invalide ou expire</h1>');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(SELFIE_HTML.replace(/__CODE__/g, req.params.code));
});

// ═══ VIDEO UPLOAD ═══
app.post('/api/upload-selfie/:code', upload.single('video'), (req, res) => {
    const code = req.params.code;
    const entry = Object.entries(accounts).find(([u, d]) => d.selfie_code === code);
    if (!entry) { if (req.file) fs.unlinkSync(req.file.path); return res.status(404).json({ ok: false }); }
    const [username, acc] = entry;
    if (acc.video_path) { try { fs.unlinkSync(acc.video_path); } catch (e) {} }
    const ext = (req.file.mimetype || '').includes('mp4') ? '.mp4' : '.webm';
    const newPath = path.join(VIDEOS_DIR, code + ext);
    fs.renameSync(req.file.path, newPath);
    acc.video_path = newPath; acc.video_mime = req.file.mimetype; acc.status = 'video_ready';
    saveData(accounts);
    console.log('[SELFIE] Video saved: ' + username + ' (' + (req.file.size / 1024).toFixed(1) + 'KB)');
    res.json({ ok: true, status: 'video_ready' });
});

// ═══ AGENT API ═══
app.get('/api/agent/status/:username', auth, (req, res) => {
    const acc = accounts[req.params.username];
    if (!acc) return res.status(404).json({ ok: false });
    res.json({ ok: true, status: acc.status, has_video: !!acc.video_path, event_session_id: acc.event_session_id });
});

app.get('/api/agent/video/:username', auth, (req, res) => {
    const acc = accounts[req.params.username];
    if (!acc || !acc.video_path || !fs.existsSync(acc.video_path)) return res.status(404).json({ ok: false });
    res.setHeader('Content-Type', acc.video_mime || 'video/webm');
    res.sendFile(path.resolve(acc.video_path));
});

app.post('/api/agent/report-session', auth, (req, res) => {
    const { username, event_session_id } = req.body;
    const acc = accounts[username];
    if (!acc) return res.status(404).json({ ok: false });
    acc.event_session_id = event_session_id; acc.status = 'accepted';
    saveData(accounts);
    console.log('[AGENT] Session: ' + username + ' → ' + event_session_id);
    res.json({ ok: true });
});

// ═══ DASHBOARD ═══
app.get('/dashboard', (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(DASHBOARD_HTML);
});

app.get('/', (req, res) => res.json({ service: '2AO Selfie', version: '4.1', status: 'running', accounts: Object.keys(accounts).length }));

// ═══════════════════════════════════════════
// SELFIE HTML
// ═══════════════════════════════════════════
const SELFIE_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>2AO Selfie</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0a0e17;color:#fff;font-family:system-ui;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;padding:12px}
h2{font-size:18px;color:#00E676;font-weight:800;margin-bottom:8px}
#camBox{position:relative;width:300px;height:400px;border:3px solid #00E676;border-radius:16px;overflow:hidden;background:#000}
#camBox video{width:100%;height:100%;object-fit:cover;transform:scaleX(-1)}
#oval{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:58%;height:62%;border-radius:50%;border:3px dashed rgba(0,230,118,.5)}
#st{text-align:center;padding:8px 14px;border-radius:8px;font-size:13px;font-weight:700;margin:10px 0;background:#1e293b}
#overlay{position:fixed;inset:0;background:rgba(10,14,23,.95);display:none;flex-direction:column;align-items:center;justify-content:center;z-index:99}
#overlay .sp{width:44px;height:44px;border:4px solid rgba(255,255,255,.1);border-top-color:#00E676;border-radius:50%;animation:r .7s linear infinite;margin-bottom:12px}
@keyframes r{to{transform:rotate(360deg)}}
.res{display:none;flex-direction:column;align-items:center;justify-content:center;text-align:center;min-height:80vh;gap:10px}
.res .ic{font-size:64px}.res .tx{font-size:20px;font-weight:700}
.res button{padding:12px 24px;background:#00E676;color:#000;border:none;border-radius:8px;font-size:15px;font-weight:700;cursor:pointer}
</style></head><body>
<h2>2AO Selfie</h2>
<div id="camWrap">
  <div id="camBox"><video id="vid" autoplay muted playsinline></video><div id="oval"></div></div>
  <div id="st">Chargement...</div>
</div>
<div id="overlay"><div class="sp"></div><p style="color:#00E676;font-weight:700;font-size:16px">Upload...</p></div>
<div class="res" id="resOK"><div class="ic">&#9989;</div><div class="tx" style="color:#00E676">Selfie enregistre!</div><div style="color:#94a3b8;font-size:13px">Vous pouvez fermer cette page</div></div>
<div class="res" id="resFail"><div class="ic">&#10060;</div><div class="tx" style="color:#ef4444">Echec</div><button onclick="location.reload()">Reessayer</button></div>

<script>
var CODE="__CODE__";
var vid=document.getElementById("vid");
var st=document.getElementById("st");
var oval=document.getElementById("oval");
var stream=null,recording=false,frontalStart=null;
var faceReady=false;

function setS(t,bg){st.textContent=t;st.style.background=bg||"#1e293b";st.style.color=bg==="#10b981"?"#000":"#fff"}

// Load face-api from CDN
function loadScript(url){
  return new Promise(function(ok,fail){
    var s=document.createElement("script");
    s.src=url;s.onload=ok;s.onerror=fail;
    document.head.appendChild(s);
  });
}

async function start(){
  try{
    setS("Chargement modeles...");
    await loadScript("https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.14/dist/face-api.min.js");
    
    var modelUrl="https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.14/model/";
    await faceapi.nets.tinyFaceDetector.loadFromUri(modelUrl);
    await faceapi.nets.faceLandmark68Net.loadFromUri(modelUrl);
    faceReady=true;
    setS("Activation camera...");
    
    stream=await navigator.mediaDevices.getUserMedia({video:{width:{ideal:640},height:{ideal:480},facingMode:"user"},audio:false});
    vid.srcObject=stream;
    vid.onloadedmetadata=function(){vid.play();setS("Centrez votre visage");detect()};
  }catch(err){
    setS("Erreur: "+err.message,"#ef4444");
    console.error("Init error:",err);
  }
}

function isFrontal(lm){
  try{
    var le=lm.getLeftEye(),re=lm.getRightEye(),n=lm.getNose();
    if(!le||!re||!n||!n[3])return false;
    var dx=n[3].x-(le[0].x+re[3].x)/2;
    return Math.abs(dx)<12;
  }catch(e){return false}
}

function inOval(box){
  if(!box)return false;
  var vw=vid.videoWidth,vh=vid.videoHeight;
  var cx=vw/2,cy=vh/2,r=Math.min(vw,vh)*0.25;
  var fx=box.x+box.width/2,fy=box.y+box.height/2;
  return Math.hypot(fx-cx,fy-cy)<r;
}

function detect(){
  if(!faceReady)return;
  var opts=new faceapi.TinyFaceDetectorOptions({inputSize:160,scoreThreshold:0.4});
  
  function loop(){
    if(recording)return;
    if(!vid.videoWidth){requestAnimationFrame(loop);return}
    
    faceapi.detectSingleFace(vid,opts).withFaceLandmarks().then(function(det){
      if(det&&isFrontal(det.landmarks)&&inOval(det.detection.box)){
        setS("Parfait! Ne bougez pas...","#10b981");
        oval.style.borderColor="#00E676";
        if(!frontalStart)frontalStart=Date.now();
        if(Date.now()-frontalStart>1500){startRec();return}
      }else if(det){
        setS("Centrez votre visage","#f59e0b");
        oval.style.borderColor="rgba(245,158,11,.8)";
        frontalStart=null;
      }else{
        setS("Aucun visage detecte","#ef4444");
        oval.style.borderColor="rgba(239,68,68,.6)";
        frontalStart=null;
      }
      requestAnimationFrame(loop);
    }).catch(function(e){
      console.error("Detect err:",e);
      requestAnimationFrame(loop);
    });
  }
  loop();
}

function startRec(){
  recording=true;
  setS("Enregistrement...","#dc2626");
  
  var mime="video/webm";
  if(typeof MediaRecorder!=="undefined"){
    if(MediaRecorder.isTypeSupported("video/webm;codecs=vp8"))mime="video/webm;codecs=vp8";
    else if(MediaRecorder.isTypeSupported("video/webm"))mime="video/webm";
    else if(MediaRecorder.isTypeSupported("video/mp4"))mime="video/mp4";
  }
  
  var rec=new MediaRecorder(stream,{mimeType:mime});
  var chunks=[];
  rec.ondataavailable=function(e){if(e.data&&e.data.size>0)chunks.push(e.data)};
  rec.onstop=function(){
    var blob=new Blob(chunks,{type:mime});
    doUpload(blob);
  };
  rec.onerror=function(e){
    console.error("Rec error:",e);
    setS("Erreur enregistrement","#ef4444");
  };
  rec.start(100);
  setTimeout(function(){
    try{rec.stop()}catch(e){}
    if(stream)stream.getTracks().forEach(function(t){t.stop()});
  },2500);
}

function doUpload(blob){
  document.getElementById("camWrap").style.display="none";
  document.getElementById("overlay").style.display="flex";
  
  var form=new FormData();
  form.append("video",blob,"selfie.webm");
  
  var xhr=new XMLHttpRequest();
  xhr.open("POST","/api/upload-selfie/"+CODE);
  xhr.onload=function(){
    document.getElementById("overlay").style.display="none";
    try{
      var d=JSON.parse(xhr.responseText);
      if(d.ok){document.getElementById("resOK").style.display="flex"}
      else{document.getElementById("resFail").style.display="flex"}
    }catch(e){document.getElementById("resFail").style.display="flex"}
  };
  xhr.onerror=function(){
    document.getElementById("overlay").style.display="none";
    document.getElementById("resFail").style.display="flex";
  };
  xhr.send(form);
}

start();
</script></body></html>`;

// ═══════════════════════════════════════════
// DASHBOARD HTML
// ═══════════════════════════════════════════
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>2AO Dashboard</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}body{background:#0a0e17;color:#e2e8f0;font-family:system-ui}
.lw{display:flex;align-items:center;justify-content:center;min-height:100vh}
.lb{background:#111827;border:1px solid #1e3a5f;border-radius:16px;padding:32px;width:380px;text-align:center}
.lb h1{color:#00E676;font-size:28px;font-weight:900;margin-bottom:4px}
.lb p{color:#64748b;font-size:13px;margin-bottom:20px}
.lb input{width:100%;padding:12px;background:#0a0e17;border:1px solid #1e3a5f;border-radius:8px;color:#e2e8f0;font-size:14px;margin-bottom:10px;outline:none}
.bg{width:100%;padding:12px;background:linear-gradient(135deg,#00C853,#00E676);color:#000;border:none;border-radius:8px;font-size:15px;font-weight:700;cursor:pointer}
#lerr{color:#ef4444;font-size:12px;margin-top:6px;min-height:18px}
#app{display:none}
.top{background:#111827;border-bottom:1px solid #1e3a5f;padding:12px 20px;display:flex;align-items:center;gap:12px}
.top h1{font-size:18px;color:#00E676;font-weight:800;flex:1}
.top .c{background:rgba(0,230,118,.15);color:#00E676;padding:4px 12px;border-radius:6px;font-size:13px;font-weight:700}
.top button{padding:6px 14px;border-radius:6px;border:1px solid #1e3a5f;background:#1e293b;color:#e2e8f0;font-size:12px;cursor:pointer}
.tb{padding:12px 20px;display:flex;gap:8px;flex-wrap:wrap}
.tb button{padding:8px 16px;border-radius:8px;border:none;font-size:13px;font-weight:600;cursor:pointer}
.tb .a{background:#00E676;color:#000}.tb .d{background:#ef4444;color:#fff}
.tb input{flex:1;min-width:150px;padding:8px 12px;background:#111827;border:1px solid #1e3a5f;border-radius:8px;color:#e2e8f0;font-size:13px;outline:none}
.g{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px;padding:12px 20px}
.cd{background:#111827;border:1px solid #1e3a5f;border-radius:12px;padding:14px;position:relative}
.cd .u{font-weight:700;font-size:15px}.cd .pw{font-size:12px;color:#64748b;margin-top:2px}
.bd{display:inline-block;padding:3px 10px;border-radius:6px;font-size:11px;font-weight:700;margin-top:8px}
.b1{background:rgba(16,185,129,.15);color:#10b981}
.b2{background:rgba(59,130,246,.15);color:#3b82f6}
.b3{background:rgba(245,158,11,.15);color:#f59e0b}
.cd .act{display:flex;gap:6px;margin-top:10px;flex-wrap:wrap}
.cd .act button{padding:5px 10px;border-radius:6px;border:1px solid #1e3a5f;background:#1e293b;color:#e2e8f0;font-size:11px;cursor:pointer}
.cd .lk{font-size:10px;color:#3b82f6;word-break:break-all;margin-top:6px;cursor:pointer}
.cd .si{font-size:9px;color:#475569;word-break:break-all;margin-top:4px}
.cd .cb{position:absolute;top:12px;right:12px}
.mb{position:fixed;inset:0;background:rgba(0,0,0,.6);display:none;align-items:center;justify-content:center;z-index:99}
.ml{background:#111827;border:1px solid #1e3a5f;border-radius:16px;padding:24px;width:360px}
.ml h3{color:#00E676;margin-bottom:12px}
.ml input{width:100%;padding:10px;background:#0a0e17;border:1px solid #1e3a5f;border-radius:8px;color:#e2e8f0;font-size:13px;margin-bottom:8px;outline:none}
.ml .bt{display:flex;gap:8px;margin-top:8px}
.ml .bt button{flex:1;padding:8px;border-radius:8px;border:none;font-size:13px;font-weight:600;cursor:pointer}
.tt{position:fixed;bottom:20px;right:20px;padding:12px 20px;border-radius:8px;font-size:13px;font-weight:600;z-index:999;display:none}
</style></head><body>
<div class="lw" id="lw"><div class="lb"><h1>2AO SELFIE</h1><p>Dashboard v4.1</p>
<input type="text" id="iu" placeholder="Username" value="admin">
<input type="password" id="ip" placeholder="Password">
<button class="bg" id="btnL">Connexion</button>
<div id="lerr"></div></div></div>
<div id="app"><div class="top"><h1>2AO SELFIE</h1><span class="c" id="cnt">0</span><button id="btnR">Refresh</button><button id="btnO">Logout</button></div>
<div class="tb"><button class="a" id="btnA">+ Nouveau</button><button class="d" id="btnD">Supprimer</button><input type="text" id="sch" placeholder="Rechercher..." oninput="flt()"></div>
<div class="g" id="grd"></div></div>
<div class="mb" id="mbg"><div class="ml"><h3>Nouveau compte</h3><input id="mu" placeholder="Email BLS"><input id="mp" placeholder="Mot de passe">
<div class="bt"><button style="background:#1e293b;color:#e2e8f0" id="btnMC">Annuler</button><button style="background:#00E676;color:#000" id="btnMS">Ajouter</button></div></div></div>
<div class="tt" id="tt"></div>
<script>
var API=location.origin,TK=localStorage.getItem("2ao_tk")||"";
function $(i){return document.getElementById(i)}
function tt(m,c){var t=$("tt");t.textContent=m;t.style.background=c;t.style.color="#fff";t.style.display="block";setTimeout(function(){t.style.display="none"},3000)}
async function api(m,p,b){try{var o={method:m,headers:{"Content-Type":"application/json","X-Auth-Token":TK}};if(b)o.body=JSON.stringify(b);var r=await fetch(API+p,o);return await r.json()}catch(e){return{ok:false,error:e.message}}}

$("btnL").onclick=async function(){
  var e=$("lerr");e.textContent="Connexion...";e.style.color="#f59e0b";
  var u=$("iu").value.trim(),p=$("ip").value;
  if(!u||!p){e.textContent="Remplissez les champs";e.style.color="#ef4444";return}
  var d=await api("POST","/api/login",{username:u,password:p});
  if(d.ok){TK=d.token;localStorage.setItem("2ao_tk",TK);$("lw").style.display="none";$("app").style.display="block";load()}
  else{e.textContent=d.error||"Erreur";e.style.color="#ef4444"}
};
$("btnO").onclick=function(){TK="";localStorage.removeItem("2ao_tk");location.reload()};
$("btnR").onclick=load;
$("btnA").onclick=function(){$("mbg").style.display="flex"};
$("btnMC").onclick=function(){$("mbg").style.display="none"};
$("btnMS").onclick=async function(){var u=$("mu").value.trim(),p=$("mp").value;if(!u)return;await api("POST","/api/accounts",{username:u,password:p});$("mbg").style.display="none";$("mu").value="";$("mp").value="";load()};
$("btnD").onclick=async function(){var c=document.querySelectorAll(".cb:checked");if(!c.length)return;if(!confirm("Supprimer "+c.length+" comptes?"))return;for(var i=0;i<c.length;i++)await api("DELETE","/api/accounts/"+encodeURIComponent(c[i].dataset.u));load()};
$("ip").onkeydown=function(e){if(e.key==="Enter")$("btnL").onclick()};

async function load(){
  var d=await api("GET","/api/accounts");
  if(!d.ok){$("btnO").onclick();return}
  $("cnt").textContent=d.total;
  var g=$("grd");g.innerHTML="";
  d.accounts.forEach(function(a){
    var lk=API+"/selfie/"+a.selfie_code;
    var bd=a.status==="accepted"?'<span class="bd b1">Accepted</span>':a.has_video?'<span class="bd b2">Video Ready</span>':'<span class="bd b3">Pending</span>';
    var si=a.event_session_id?'<div class="si">'+a.event_session_id+"</div>":"";
    var eu=encodeURIComponent(a.username);
    g.innerHTML+='<div class="cd" data-user="'+a.username+'"><input type="checkbox" class="cb" data-u="'+a.username+'"><div class="u">'+a.username+'</div><div class="pw">'+a.password+'</div>'+bd+si+'<div class="lk" onclick="navigator.clipboard.writeText(this.textContent)">'+lk+'</div><div class="act"><button data-gl="'+eu+'">New Link</button><button data-dl="'+eu+'">Suppr</button></div></div>';
  });
  document.querySelectorAll("[data-gl]").forEach(function(b){b.onclick=function(){gl(b.dataset.gl)}});
  document.querySelectorAll("[data-dl]").forEach(function(b){b.onclick=function(){dl(b.dataset.dl)}});
  document.querySelectorAll(".lk").forEach(function(l){l.onclick=function(){navigator.clipboard.writeText(l.textContent);tt("Copie!","#10b981")}});
}
async function gl(u){await api("POST","/api/accounts/"+u+"/generate-link");tt("Nouveau lien","#3b82f6");load()}
async function dl(u){if(!confirm("Supprimer?"))return;await api("DELETE","/api/accounts/"+u);load()}
function flt(){var q=$("sch").value.toLowerCase();document.querySelectorAll(".cd").forEach(function(c){c.style.display=c.dataset.user.toLowerCase().includes(q)?"":"none"})}

if(TK)api("GET","/api/accounts").then(function(d){if(d.ok){$("lw").style.display="none";$("app").style.display="block";load()}});
</script></body></html>`;

app.listen(PORT, () => console.log('  2AO Selfie v4.1 | Port ' + PORT + ' | /dashboard'));
