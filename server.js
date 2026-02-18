/**
 * 2AO Selfie Server v2.0
 * Dashboard + Selfie Account Management + Legacy support
 */
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
    const ts = new Date().toISOString().substring(11, 19);
    if (req.path !== '/dashboard' && req.path !== '/health') console.log(`[${ts}] ${req.method} ${req.path}`);
    next();
});

// ═══ STORAGE ═══
const tasks = {}, results = {};
const accounts = {};
const sessions = {};
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';

setInterval(() => {
    const now = Date.now(), MAX = 30*60*1000;
    for (const c in tasks) { if (now - (tasks[c].timestamp||0) > MAX) delete tasks[c]; }
    for (const c in results) { if (now - (results[c].timestamp||0) > MAX) delete results[c]; }
}, 5*60*1000);

function genCode(n=8) { const c='abcdefghijklmnopqrstuvwxyz0123456789'; let s=''; for(let i=0;i<n;i++) s+=c[Math.floor(Math.random()*c.length)]; return s; }
function genToken() { return crypto.randomBytes(32).toString('hex'); }
function escJs(s) { return (s||'').replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/"/g,'\\"').replace(/</g,'\\x3c').replace(/>/g,'\\x3e'); }
function authCheck(req) { const t = req.headers['x-auth-token']||req.query.token||''; return sessions[t]||null; }

// ═══ AUTH ═══
app.post('/api/login', (req, res) => {
    const {username,password} = req.body||{};
    if (username===ADMIN_USER && password===ADMIN_PASS) {
        const token = genToken();
        sessions[token] = { username, role:'admin', loginAt:Date.now() };
        return res.json({ ok:true, token });
    }
    res.status(401).json({ ok:false, error:'Invalid credentials' });
});

// ═══ ACCOUNTS CRUD ═══
app.get('/api/accounts', (req, res) => {
    if (!authCheck(req)) return res.status(401).json({ok:false});
    const list = Object.values(accounts).map(a => ({...a}));
    res.json({ ok:true, total:list.length, accounts:list });
});

app.post('/api/accounts', (req, res) => {
    if (!authCheck(req)) return res.status(401).json({ok:false});
    const {username,password,profile,photo} = req.body||{};
    if (!username||!password) return res.status(400).json({ok:false, error:'Username and password required'});
    if (accounts[username]) return res.status(409).json({ok:false, error:'Already exists'});
    const selfieCode = genCode(8);
    accounts[username] = { username, password, profile:profile||'', photo:photo||'', selfieCode, event_session_id:'', status:'pending', selfieLink:'', createdAt:Date.now(), updatedAt:Date.now() };
    console.log(`[ACCOUNT] ➕ ${username} (code:${selfieCode})`);
    res.json({ ok:true, account:accounts[username] });
});

app.put('/api/accounts/:username', (req, res) => {
    if (!authCheck(req)) return res.status(401).json({ok:false});
    const a = accounts[req.params.username];
    if (!a) return res.status(404).json({ok:false});
    const u = req.body||{};
    if (u.password) a.password=u.password;
    if (u.profile) a.profile=u.profile;
    if (u.photo) a.photo=u.photo;
    a.updatedAt=Date.now();
    res.json({ ok:true, account:a });
});

app.delete('/api/accounts/:username', (req, res) => {
    if (!authCheck(req)) return res.status(401).json({ok:false});
    delete accounts[req.params.username];
    res.json({ ok:true });
});

app.post('/api/accounts/bulk-delete', (req, res) => {
    if (!authCheck(req)) return res.status(401).json({ok:false});
    const {usernames} = req.body||{};
    let d=0;
    if (Array.isArray(usernames)) usernames.forEach(u => { if(accounts[u]){delete accounts[u];d++;} });
    res.json({ ok:true, deleted:d });
});

app.post('/api/accounts/check-all', (req, res) => {
    if (!authCheck(req)) return res.status(401).json({ok:false});
    res.json({ ok:true, accounts: Object.values(accounts).map(a=>({username:a.username, status:a.status, event_session_id:a.event_session_id||''})) });
});

// ═══ GENERATE SELFIE LINK ═══
app.post('/api/accounts/:username/generate-link', (req, res) => {
    if (!authCheck(req)) return res.status(401).json({ok:false});
    const a = accounts[req.params.username];
    if (!a) return res.status(404).json({ok:false});
    if (!a.selfieCode) a.selfieCode = genCode(8);
    a.status='pending'; a.event_session_id=''; a.updatedAt=Date.now();
    const base = `${req.protocol}://${req.get('host')}`;
    a.selfieLink = `${base}/selfie/${a.selfieCode}`;
    console.log(`[LINK] 🔗 ${a.username}: ${a.selfieLink}`);
    res.json({ ok:true, selfieLink:a.selfieLink, selfieCode:a.selfieCode });
});

// ═══ SELFIE RESULT (for Agent) ═══
app.get('/api/selfie-result/:username', (req, res) => {
    if (!authCheck(req)) return res.status(401).json({ok:false});
    const a = accounts[req.params.username];
    if (!a) return res.status(404).json({ok:false});
    res.json({ ok:true, username:a.username, status:a.status, event_session_id:a.event_session_id||'', selfieCode:a.selfieCode });
});

// ═══ SELFIE PAGE (client opens this on phone) ═══
app.get('/selfie/:code', (req, res) => {
    const {code} = req.params;
    const account = Object.values(accounts).find(a => a.selfieCode===code);
    if (!account) return res.status(404).send('<html><body style="background:#0a0a0a;color:#fff;display:flex;justify-content:center;align-items:center;height:100vh;font-family:system-ui"><div style="text-align:center"><h1>❌ Lien invalide</h1><p>Ce lien n\'existe pas ou a expiré.</p></div></body></html>');
    if (account.status==='accepted' && account.event_session_id) return res.send('<html><body style="background:#059669;color:#fff;display:flex;justify-content:center;align-items:center;height:100vh;font-family:system-ui"><div style="text-align:center"><div style="font-size:80px">✅</div><h1>Selfie déjà complété</h1><p>Vous pouvez fermer cette page.</p></div></body></html>');

    const fakeUid = 'user_'+genCode(12);
    const fakeTxn = 'txn_'+genCode(16);
    const serverUrl = `${req.protocol}://${req.get('host')}`;

    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"><title>BLS Liveness</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{background:#08090d;font-family:system-ui;color:#fff;min-height:100vh}
#load{position:fixed;inset:0;z-index:10000;display:flex;flex-direction:column;align-items:center;justify-content:center;background:linear-gradient(135deg,#0f172a,#1e293b)}
.ring{width:60px;height:60px;border:4px solid rgba(255,255,255,.1);border-top-color:#38bdf8;border-radius:50%;animation:spin 1s linear infinite;margin-bottom:20px}
@keyframes spin{to{transform:rotate(360deg)}}#stxt{font-size:16px;font-weight:600;color:#94a3b8}
#ok-screen{position:fixed;inset:0;z-index:20000;display:none;align-items:center;justify-content:center;background:linear-gradient(135deg,#0d9488,#059669);overflow:hidden}
@keyframes confetti{0%{opacity:1;transform:translateY(0) rotate(0)}100%{opacity:0;transform:translateY(100vh) rotate(720deg)}}
@keyframes pop{0%{transform:scale(0);opacity:0}50%{transform:scale(1.15)}100%{transform:scale(1);opacity:1}}
@keyframes bounce{0%,100%{transform:translateY(0)}50%{transform:translateY(-10px)}}
.ozliveness_logo,.ozliveness_version{display:none!important}</style></head><body>
<div id="load"><div class="ring"></div><div id="stxt">Chargement du SDK...</div></div>
<div id="oz-container"></div>
<div id="ok-screen"><div id="cbox"></div>
<div style="text-align:center;z-index:2;animation:pop .6s ease-out forwards">
<div style="font-size:80px;margin-bottom:10px;animation:bounce 1.5s ease-in-out infinite">🎉</div>
<div style="font-size:32px;font-weight:900;color:#fff;margin-bottom:8px">FÉLICITATIONS !</div>
<div style="font-size:18px;font-weight:700;color:rgba(255,255,255,.9);margin-bottom:6px">✅ Selfie réussi</div>
<div style="font-size:14px;color:rgba(255,255,255,.7);margin-bottom:20px">يمكنك الان اغلاق هذه الصفحة</div>
<div style="font-size:13px;color:rgba(255,255,255,.6)">Fermeture dans <span id="cd">5</span>s</div>
</div></div>
<script src="https://web-sdk.prod.cdn.spain.ozforensics.com/blsinternational/plugin_liveness.php"></script>
<script>
(function(){
var CODE='${escJs(code)}',SERVER='${escJs(serverUrl)}',UID='${escJs(fakeUid)}',TXN='${escJs(fakeTxn)}';
var stxt=document.getElementById('stxt');
function showOK(){
document.getElementById('load').style.display='none';
var s=document.getElementById('ok-screen');s.style.display='flex';
var b=document.getElementById('cbox'),co=['#FFD700','#FF6B35','#F7931E','#4ade80','#60a5fa','#c084fc','#fb7185','#fff'];
for(var i=0;i<50;i++){var d=document.createElement('div');d.style.cssText='position:absolute;top:-10px;left:'+Math.random()*100+'%;width:'+(4+Math.random()*8)+'px;height:'+(4+Math.random()*8)+'px;background:'+co[Math.floor(Math.random()*8)]+';border-radius:'+(Math.random()>.5?'50%':'2px')+';animation:confetti '+(2+Math.random()*3)+'s ease-out '+Math.random()*2+'s forwards;opacity:0';b.appendChild(d);}
var sec=5,ce=document.getElementById('cd');setInterval(function(){sec--;if(ce)ce.textContent=sec;if(sec<=0)try{window.close();}catch(e){}},1000);
}
window.addEventListener('load',function(){
stxt.textContent='Préparation caméra...';
setTimeout(function(){
if(typeof OzLiveness==='undefined'){stxt.textContent='❌ SDK non chargé';return;}
stxt.textContent='📸 Ouverture caméra...';document.getElementById('load').style.display='none';
OzLiveness.open({lang:'en',meta:{'user_id':UID,'transaction_id':TXN},overlay_options:false,action:['video_selfie_blank'],
on_complete:function(r){var sid=r&&r.event_session_id?String(r.event_session_id):'';
if(sid){fetch(SERVER+'/api/selfie-complete/'+CODE,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({event_session_id:sid,timestamp:Date.now()})}).catch(function(){});showOK();}
else{stxt.textContent='❌ Pas de session ID';}},
on_error:function(e){stxt.textContent='❌ '+(e&&e.message||e);}});
},2000);});
})();
</script></body></html>`;
    res.setHeader('Content-Type','text/html; charset=utf-8');
    res.send(html);
});

// ═══ SELFIE COMPLETE (called by selfie page) ═══
app.post('/api/selfie-complete/:code', (req, res) => {
    const {code} = req.params;
    const {event_session_id} = req.body||{};
    const account = Object.values(accounts).find(a => a.selfieCode===code);
    if (!account) return res.status(404).json({ok:false});
    if (!event_session_id) return res.status(400).json({ok:false});
    account.event_session_id = event_session_id;
    account.status = 'accepted';
    account.updatedAt = Date.now();
    console.log(`[SELFIE] ✅ ${account.username}: session=${event_session_id.substring(0,20)}...`);
    res.json({ ok:true });
});


const DASHBOARD_HTML = `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>2AO Selfie — Dashboard</title>
<style>
:root{--bg:#0a0e17;--sf:#111827;--sf2:#1e293b;--bd:#1e3a5f;--tx:#e2e8f0;--mt:#64748b;--gn:#10b981;--or:#f59e0b;--rd:#ef4444;--bl:#3b82f6;--ac:#00E676}
*{box-sizing:border-box;margin:0;padding:0}body{background:var(--bg);color:var(--tx);font-family:'Segoe UI',system-ui,sans-serif;min-height:100vh}
#login-screen{display:flex;align-items:center;justify-content:center;min-height:100vh}
.login-box{background:var(--sf);border:1px solid var(--bd);border-radius:16px;padding:40px;width:360px;text-align:center}
.login-box h1{font-size:28px;margin-bottom:8px;background:linear-gradient(135deg,#00C853,#00E676,#1DE9B6);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.login-box p{color:var(--mt);margin-bottom:24px;font-size:14px}
.login-box input{width:100%;padding:12px 16px;background:var(--bg);border:1px solid var(--bd);border-radius:10px;color:var(--tx);font-size:14px;margin-bottom:12px;outline:none}
.login-box input:focus{border-color:var(--ac)}
.login-box button{width:100%;padding:12px;background:linear-gradient(135deg,#00C853,#00E676);color:#000;border:none;border-radius:10px;font-size:15px;font-weight:700;cursor:pointer}
#login-error{color:var(--rd);font-size:13px;margin-top:8px;display:none}
#app{display:none}
.topbar{display:flex;align-items:center;justify-content:space-between;padding:16px 24px;background:var(--sf);border-bottom:1px solid var(--bd)}
.topbar h1{font-size:20px;display:flex;align-items:center;gap:10px}
.logo{width:32px;height:32px;background:linear-gradient(135deg,#00C853,#00E676);border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:13px;color:#000}
.topbar-actions{display:flex;gap:10px;align-items:center}
.cnt{background:var(--ac);color:#000;padding:2px 10px;border-radius:12px;font-weight:700;font-size:13px}
.toolbar{display:flex;gap:10px;padding:16px 24px;flex-wrap:wrap;align-items:center}
.btn{padding:8px 16px;border-radius:8px;border:1px solid var(--bd);background:var(--sf2);color:var(--tx);font-size:13px;font-weight:600;cursor:pointer;display:inline-flex;align-items:center;gap:6px;transition:.2s}
.btn:hover{background:var(--bd)}.btn-g{background:var(--gn);color:#fff;border-color:var(--gn)}.btn-r{background:var(--rd);color:#fff;border-color:var(--rd)}.btn-b{background:var(--bl);color:#fff;border-color:var(--bl)}
.search{flex:1;min-width:200px;padding:8px 14px;background:var(--bg);border:1px solid var(--bd);border-radius:8px;color:var(--tx);font-size:13px;outline:none}
.search:focus{border-color:var(--ac)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:16px;padding:0 24px 24px}
.card{background:var(--sf);border:1px solid var(--bd);border-radius:14px;padding:16px;position:relative;transition:.2s}
.card:hover{border-color:var(--ac);transform:translateY(-2px)}
.card-ph{width:64px;height:64px;border-radius:50%;margin:0 auto 12px;background:var(--sf2);display:flex;align-items:center;justify-content:center;font-size:28px;overflow:hidden;border:2px solid var(--bd)}
.card-ph img{width:100%;height:100%;object-fit:cover}
.card-info{text-align:center}
.card-info .nm{font-weight:700;font-size:14px;margin-bottom:4px}
.card-info .dt{font-size:12px;color:var(--mt);margin-bottom:2px}
.card-lk{display:flex;align-items:center;gap:4px;margin-top:8px;justify-content:center}
.card-lk span{font-size:11px;color:var(--mt);max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cpb{background:none;border:none;color:var(--bl);cursor:pointer;font-size:14px;padding:2px}
.badge{display:inline-block;padding:3px 10px;border-radius:6px;font-size:11px;font-weight:700;text-transform:uppercase;margin-top:8px}
.b-ok{background:rgba(16,185,129,.15);color:var(--gn)}.b-pn{background:rgba(245,158,11,.15);color:var(--or)}.b-er{background:rgba(239,68,68,.15);color:var(--rd)}
.card-act{display:flex;gap:6px;margin-top:10px;justify-content:center}.card-act .btn{padding:5px 10px;font-size:11px}
.card-ck{position:absolute;top:10px;right:10px}
.card-ck input{width:16px;height:16px;cursor:pointer;accent-color:var(--ac)}
.modal-ov{position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:10000;display:none;align-items:center;justify-content:center}
.modal-ov.show{display:flex}
.modal{background:var(--sf);border:1px solid var(--bd);border-radius:16px;padding:28px;width:400px;max-width:95vw}
.modal h2{font-size:18px;margin-bottom:16px}
.modal label{display:block;font-size:13px;font-weight:600;color:var(--mt);margin:12px 0 4px}
.modal input,.modal select{width:100%;padding:10px 14px;background:var(--bg);border:1px solid var(--bd);border-radius:8px;color:var(--tx);font-size:14px;outline:none}
.modal input:focus{border-color:var(--ac)}
.modal-act{display:flex;gap:10px;margin-top:20px;justify-content:flex-end}
.toast{position:fixed;bottom:24px;right:24px;background:var(--sf);border:1px solid var(--bd);border-radius:12px;padding:14px 20px;z-index:20000;display:flex;align-items:center;gap:10px;font-size:14px;font-weight:600;box-shadow:0 8px 32px rgba(0,0,0,.4);transform:translateY(100px);opacity:0;transition:.3s}
.toast.show{transform:translateY(0);opacity:1}
.t-ok{border-color:var(--gn)}.t-info{border-color:var(--bl)}.t-err{border-color:var(--rd)}
@media(max-width:600px){.grid{grid-template-columns:1fr 1fr;gap:10px;padding:0 12px 12px}.toolbar{padding:12px}}
</style></head><body>

<div id="login-screen">
<div class="login-box">
<h1>2AO SELFIE</h1><p>Système de gestion Liveness</p>
<input type="text" id="loginUser" placeholder="Username" autofocus>
<input type="password" id="loginPass" placeholder="Password">
<button onclick="doLogin()">🔐 Connexion</button>
<div id="login-error">Identifiants incorrects</div>
</div></div>

<div id="app">
<div class="topbar">
<h1><div class="logo">2A</div> 2AO Selfie</h1>
<div class="topbar-actions">
<span>Total Livenesses:</span><span class="cnt" id="totalCount">0</span>
<button class="btn" onclick="refresh()" title="Refresh">🔄</button>
<button class="btn btn-r" onclick="doLogout()" style="font-size:12px">Logout</button>
</div></div>

<div class="toolbar">
<button class="btn btn-g" onclick="showAdd()">➕ New Liveness</button>
<button class="btn btn-b" onclick="checkAll()">✅ Check All</button>
<button class="btn btn-r" onclick="delSel()">🗑️ Delete</button>
<input class="search" type="text" id="searchInput" placeholder="🔍 Search..." oninput="filter()">
</div>
<div class="grid" id="grid"></div>
</div>

<div class="modal-ov" id="addModal">
<div class="modal">
<h2>➕ Add Selfie Account</h2>
<label>Select a profile to associate with the liveness check.</label>
<select id="mProfile"><option value="">— Select Profile —</option></select>
<label>User Name *</label><input type="text" id="mUser" placeholder="Username">
<label>Password *</label><input type="text" id="mPass" value="123">
<div class="modal-act">
<button class="btn btn-g" onclick="saveAcc()">💾 Save</button>
<button class="btn btn-r" onclick="closeAdd()">Cancel</button>
</div></div></div>

<div class="toast" id="toast"></div>

<script>
var TOKEN='',SERVER=location.origin,ALL=[];

function doLogin(){
var u=document.getElementById('loginUser').value.trim(),p=document.getElementById('loginPass').value;
fetch(SERVER+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,password:p})})
.then(r=>r.json()).then(d=>{if(d.ok){TOKEN=d.token;localStorage.setItem('2ao_t',TOKEN);showApp();}else document.getElementById('login-error').style.display='block';})
.catch(()=>document.getElementById('login-error').style.display='block');
}
function doLogout(){TOKEN='';localStorage.removeItem('2ao_t');document.getElementById('app').style.display='none';document.getElementById('login-screen').style.display='flex';}
function showApp(){document.getElementById('login-screen').style.display='none';document.getElementById('app').style.display='block';refresh();}

function api(m,p,b){var o={method:m,headers:{'Content-Type':'application/json','X-Auth-Token':TOKEN}};if(b)o.body=JSON.stringify(b);return fetch(SERVER+p,o).then(r=>{if(r.status===401){doLogout();throw new Error('Unauth');}return r.json();});}

function refresh(){api('GET','/api/accounts').then(d=>{if(d.ok){ALL=d.accounts;document.getElementById('totalCount').textContent=d.total;render(ALL);}});}

function render(list){
var g=document.getElementById('grid');g.innerHTML='';
list.forEach(a=>{
var sc=a.status==='accepted'?'b-ok':a.status==='error'?'b-er':'b-pn';
var ph=a.photo?'<img src="'+a.photo+'">':'👤';
var lk='';
if(a.selfieLink){lk='<div class="card-lk"><span title="'+a.selfieLink+'">COPY Link:</span><button class="cpb" onclick="copyLk(\\''+a.username+'\\')" title="Copy">📋</button></div>';}
else{lk='<div class="card-lk"><span>COPY Link:</span><button class="cpb" onclick="genLk(\\''+a.username+'\\')" title="Generate">🔗</button></div>';}
g.innerHTML+='<div class="card" data-u="'+a.username+'">'+
'<div class="card-ck"><input type="checkbox" class="scb" data-u="'+a.username+'"></div>'+
'<div class="card-ph">'+ph+'</div>'+
'<div class="card-info">'+
'<div class="nm">Username: '+a.username+'</div>'+
'<div class="dt">Password: '+a.password+'</div>'+lk+
'<div class="badge '+sc+'">'+a.status+'</div>'+
'</div>'+
'<div class="card-act">'+
'<button class="btn btn-b" onclick="chk1(\\''+a.username+'\\')">🔍 Check</button>'+
'<button class="btn btn-r" onclick="del1(\\''+a.username+'\\')">🗑️</button>'+
'</div></div>';
});
}

function showAdd(){document.getElementById('addModal').classList.add('show');document.getElementById('mUser').value='';document.getElementById('mPass').value='123';document.getElementById('mUser').focus();}
function closeAdd(){document.getElementById('addModal').classList.remove('show');}

function saveAcc(){
var u=document.getElementById('mUser').value.trim(),p=document.getElementById('mPass').value.trim(),pr=document.getElementById('mProfile').value;
if(!u||!p){toast('Username et password requis','err');return;}
api('POST','/api/accounts',{username:u,password:p,profile:pr}).then(d=>{if(d.ok){toast('✅ Compte '+u+' créé','ok');closeAdd();refresh();}else toast('❌ '+(d.error||'Erreur'),'err');});
}

function genLk(u){
api('POST','/api/accounts/'+u+'/generate-link').then(d=>{
if(d.ok){navigator.clipboard.writeText(d.selfieLink).then(()=>toast('🔗 Lien copié!','info')).catch(()=>toast('🔗 '+d.selfieLink,'info'));refresh();}
});
}

function copyLk(u){var a=ALL.find(x=>x.username===u);if(a&&a.selfieLink)navigator.clipboard.writeText(a.selfieLink).then(()=>toast('📋 Lien copié!','ok'));}
function chk1(u){api('GET','/api/selfie-result/'+u).then(d=>{if(d.ok){toast(u+': '+(d.status==='accepted'?'✅ Accepted':'⏳ Pending'),d.status==='accepted'?'ok':'info');refresh();}});}
function checkAll(){api('POST','/api/accounts/check-all').then(d=>{if(d.ok){toast('✅ Vérification terminée','ok');refresh();}});}
function del1(u){if(!confirm('Supprimer '+u+'?'))return;api('DELETE','/api/accounts/'+u).then(()=>{toast('🗑️ Supprimé','ok');refresh();});}
function delSel(){
var cbs=document.querySelectorAll('.scb:checked'),us=Array.from(cbs).map(c=>c.dataset.u);
if(!us.length){toast('Sélectionnez des comptes','err');return;}
if(!confirm('Supprimer '+us.length+' comptes?'))return;
api('POST','/api/accounts/bulk-delete',{usernames:us}).then(()=>{toast('🗑️ '+us.length+' supprimés','ok');refresh();});
}
function filter(){var q=document.getElementById('searchInput').value.toLowerCase();render(ALL.filter(a=>a.username.toLowerCase().includes(q)));}
function toast(m,t){var e=document.getElementById('toast');e.className='toast t-'+(t||'info')+' show';e.innerHTML=m;setTimeout(()=>e.classList.remove('show'),3500);}

document.getElementById('loginPass').addEventListener('keydown',e=>{if(e.key==='Enter')doLogin();});
document.getElementById('loginUser').addEventListener('keydown',e=>{if(e.key==='Enter')document.getElementById('loginPass').focus();});
var st=localStorage.getItem('2ao_t');
if(st){TOKEN=st;api('GET','/api/accounts').then(d=>{if(d.ok)showApp();else doLogout();}).catch(()=>doLogout());}
</script></body></html>
`;

// ═══ DASHBOARD ═══
app.get('/dashboard', (req, res) => {
    res.setHeader('Content-Type','text/html; charset=utf-8');
    res.send(DASHBOARD_HTML);
});

// ═══ LEGACY ROUTES ═══
app.post('/task/:code', (req, res) => {
    const c=req.params.code, b=req.body||{};
    if(!b.userId||!b.transactionId) return res.status(400).json({ok:false});
    tasks[c]={userId:b.userId,transactionId:b.transactionId,realIp:b.realIp||'',proxy:b.proxy||'',cookies:b.cookies||'',userAgent:b.userAgent||'',pageUrl:b.pageUrl||'',verificationToken:b.verificationToken||'',timestamp:b.timestamp||Date.now()};
    res.json({ok:true});
});
app.get('/task/:code', (req, res) => { const t=tasks[req.params.code]; res.json(t?{ok:true,task:t}:{ok:false,task:null}); });
app.post('/result/:code', (req, res) => {
    const c=req.params.code,b=req.body||{};
    if(!b.event_session_id) return res.status(400).json({ok:false});
    results[c]={event_session_id:b.event_session_id,status:b.status||'completed',realIp:b.realIp||'',timestamp:b.timestamp||Date.now()};
    delete tasks[c]; res.json({ok:true});
});
app.get('/result/:code', (req, res) => { const r=results[req.params.code]; res.json(r?{ok:true,result:r}:{ok:false,result:null}); });
app.delete('/clear/:code', (req, res) => { delete tasks[req.params.code]; delete results[req.params.code]; res.json({ok:true}); });

// ═══ HEALTH ═══
app.get('/', (req, res) => res.json({service:'2AO Selfie',version:'2.0',status:'running',accounts:Object.keys(accounts).length,uptime:Math.floor(process.uptime())+'s'}));
app.get('/health', (req, res) => res.json({ok:true}));

app.listen(PORT, () => { console.log(`\n🔥 2AO Selfie Server v2.0\n   Port: ${PORT}\n   Dashboard: /dashboard\n   Ready!\n`); });
