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

// ═══ DASHBOARD ═══
app.get('/dashboard', (req, res) => {
    res.setHeader('Content-Type','text/html; charset=utf-8');
    res.sendFile(__dirname + '/dashboard.html');
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
