/**
 * 2AO Selfie Server v2.0
 * Deploy on Render: https://dz34sni-26.onrender.com
 *
 * NEW FLOW (v2 — username/password based):
 * ──────────────────────────────────────────────────────────────────
 * 1. Agent extension captures OZ userId + transactionId on BLS page
 * 2. Agent POSTs /task/:username  { password, userId, transactionId, ... }
 * 3. APK client polls GET /task/:username?password=...  → receives task
 * 4. APK opens camera, records 2-3s selfie video (WebM)
 * 5. APK POSTs /video/:username  { password, video: base64 WebM }
 * 6. Agent polls GET /video/:username?password=...  → gets video blob
 * 7. Agent feeds video to virtual camera → OZ SDK uses it
 * 8. OZ returns event_session_id → Agent POSTs /result/:username
 * 9. Cleanup DELETE /clear/:username
 * ──────────────────────────────────────────────────────────────────
 */

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

// ═══════════════════════════════════════════
// MIDDLEWARE
// ═══════════════════════════════════════════
app.use(cors());
app.use(express.json({ limit: '50mb' }));       // Video can be large
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

app.use((req, res, next) => {
    const ts = new Date().toISOString().substring(11, 19);
    const size = req.headers['content-length'] ? ` [${(parseInt(req.headers['content-length'])/1024).toFixed(0)}KB]` : '';
    console.log(`[${ts}] ${req.method} ${req.path}${size}`);
    next();
});

// ═══════════════════════════════════════════
// IN-MEMORY STORAGE
// ═══════════════════════════════════════════
const tasks = {};        // username → { password_hash, userId, transactionId, ... }
const videos = {};       // username → { password_hash, videoBase64, format, timestamp }
const results = {};      // username → { password_hash, event_session_id, ... }

function hashPass(password) {
    return crypto.createHash('sha256').update(password || '').digest('hex').substring(0, 16);
}

function checkAuth(stored, providedPassword) {
    if (!stored || !stored.password_hash) return false;
    return stored.password_hash === hashPass(providedPassword);
}

// Auto-cleanup: remove entries older than 45 minutes
setInterval(() => {
    const now = Date.now();
    const MAX_AGE = 45 * 60 * 1000;
    for (const u in tasks) {
        if (now - (tasks[u].timestamp || 0) > MAX_AGE) {
            delete tasks[u];
            console.log(`[CLEANUP] Task: ${u}`);
        }
    }
    for (const u in videos) {
        if (now - (videos[u].timestamp || 0) > MAX_AGE) {
            delete videos[u];
            console.log(`[CLEANUP] Video: ${u}`);
        }
    }
    for (const u in results) {
        if (now - (results[u].timestamp || 0) > MAX_AGE) {
            delete results[u];
            console.log(`[CLEANUP] Result: ${u}`);
        }
    }
}, 5 * 60 * 1000);

// ═══════════════════════════════════════════
// ROUTES: TASK (Agent → APK Client)
// ═══════════════════════════════════════════

// Agent creates a task for a username
app.post('/task/:username', (req, res) => {
    const username = req.params.username.toLowerCase().trim();
    const body = req.body || {};

    if (!body.password) {
        return res.status(400).json({ ok: false, error: 'Missing password' });
    }
    if (!body.userId || !body.transactionId) {
        return res.status(400).json({ ok: false, error: 'Missing userId or transactionId' });
    }

    const ph = hashPass(body.password);

    tasks[username] = {
        password_hash: ph,
        userId: body.userId,
        transactionId: body.transactionId,
        realIp: body.realIp || '',
        proxy: body.proxy || '',
        cookies: body.cookies || '',
        userAgent: body.userAgent || '',
        pageUrl: body.pageUrl || '',
        verificationToken: body.verificationToken || '',
        timestamp: Date.now()
    };

    // Clear old video/result for this user
    delete videos[username];
    delete results[username];

    console.log(`[TASK] 📥 ${username}: userId=${body.userId.substring(0, 20)}... ip=${body.realIp || '-'}`);
    res.json({ ok: true, message: 'Task created' });
});

// APK client polls for task
app.get('/task/:username', (req, res) => {
    const username = req.params.username.toLowerCase().trim();
    const password = req.query.password || req.headers['x-password'] || '';
    const task = tasks[username];

    if (!task) {
        return res.json({ ok: false, task: null });
    }
    if (!checkAuth(task, password)) {
        return res.status(401).json({ ok: false, error: 'Invalid password' });
    }

    console.log(`[TASK] 📤 ${username}: sending task`);
    // Send task WITHOUT password_hash
    const { password_hash, ...safeTask } = task;
    res.json({ ok: true, task: safeTask });
});

// ═══════════════════════════════════════════
// ROUTES: VIDEO (APK → Server → Agent)
// ═══════════════════════════════════════════

// APK uploads selfie video
app.post('/video/:username', (req, res) => {
    const username = req.params.username.toLowerCase().trim();
    const body = req.body || {};

    if (!body.password) {
        return res.status(400).json({ ok: false, error: 'Missing password' });
    }
    if (!body.video) {
        return res.status(400).json({ ok: false, error: 'Missing video data' });
    }

    // Check password matches task password
    const task = tasks[username];
    if (task && !checkAuth(task, body.password)) {
        return res.status(401).json({ ok: false, error: 'Invalid password' });
    }

    const ph = hashPass(body.password);
    const videoSize = body.video.length;

    videos[username] = {
        password_hash: ph,
        video: body.video,              // base64 encoded WebM
        format: body.format || 'webm',
        width: body.width || 640,
        height: body.height || 480,
        duration: body.duration || 3000,
        timestamp: Date.now()
    };

    console.log(`[VIDEO] 📹 ${username}: ${(videoSize / 1024).toFixed(0)}KB ${body.format || 'webm'} ${body.width||'?'}x${body.height||'?'}`);
    res.json({ ok: true, size: videoSize });
});

// Agent downloads selfie video
app.get('/video/:username', (req, res) => {
    const username = req.params.username.toLowerCase().trim();
    const password = req.query.password || req.headers['x-password'] || '';
    const video = videos[username];

    if (!video) {
        return res.json({ ok: false, video: null });
    }
    if (!checkAuth(video, password)) {
        return res.status(401).json({ ok: false, error: 'Invalid password' });
    }

    console.log(`[VIDEO] 📤 ${username}: sending video`);
    res.json({
        ok: true,
        video: video.video,
        format: video.format,
        width: video.width,
        height: video.height,
        duration: video.duration
    });
});

// Agent can also get video as raw binary (for efficiency)
app.get('/video-raw/:username', (req, res) => {
    const username = req.params.username.toLowerCase().trim();
    const password = req.query.password || req.headers['x-password'] || '';
    const video = videos[username];

    if (!video) {
        return res.status(404).send('No video');
    }
    if (!checkAuth(video, password)) {
        return res.status(401).send('Unauthorized');
    }

    const buf = Buffer.from(video.video, 'base64');
    const mime = video.format === 'mp4' ? 'video/mp4' : 'video/webm';
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Length', buf.length);
    res.setHeader('X-Video-Width', video.width || 640);
    res.setHeader('X-Video-Height', video.height || 480);
    res.setHeader('X-Video-Duration', video.duration || 3000);
    res.send(buf);
});

// ═══════════════════════════════════════════
// ROUTES: RESULT (After OZ SDK completes)
// ═══════════════════════════════════════════

app.post('/result/:username', (req, res) => {
    const username = req.params.username.toLowerCase().trim();
    const body = req.body || {};

    if (!body.event_session_id) {
        return res.status(400).json({ ok: false, error: 'Missing event_session_id' });
    }

    const ph = hashPass(body.password || '');

    results[username] = {
        password_hash: ph,
        event_session_id: body.event_session_id,
        status: body.status || 'completed',
        realIp: body.realIp || '',
        timestamp: Date.now()
    };

    // Clean up task & video
    delete tasks[username];

    console.log(`[RESULT] ✅ ${username}: session=${body.event_session_id.substring(0, 20)}...`);
    res.json({ ok: true });
});

app.get('/result/:username', (req, res) => {
    const username = req.params.username.toLowerCase().trim();
    const password = req.query.password || req.headers['x-password'] || '';
    const result = results[username];

    if (!result) {
        return res.json({ ok: false, result: null });
    }
    // For result polling, allow if password matches OR if no password stored (backward compat)
    if (result.password_hash && result.password_hash !== hashPass('') && !checkAuth(result, password)) {
        return res.status(401).json({ ok: false, error: 'Invalid password' });
    }

    const { password_hash, ...safeResult } = result;
    res.json({ ok: true, result: safeResult });
});

// ═══════════════════════════════════════════
// ROUTES: CLEANUP
// ═══════════════════════════════════════════

app.delete('/clear/:username', (req, res) => {
    const username = req.params.username.toLowerCase().trim();
    delete tasks[username];
    delete videos[username];
    delete results[username];
    console.log(`[CLEAR] 🗑️ ${username}`);
    res.json({ ok: true });
});

// ═══════════════════════════════════════════
// ROUTES: STATUS CHECK (for APK/Extension to verify login)
// ═══════════════════════════════════════════

app.post('/auth/check', (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) {
        return res.status(400).json({ ok: false, error: 'Missing credentials' });
    }
    // Just validate format — any username/password pair is valid
    // The pair must match when exchanging data
    res.json({
        ok: true,
        username: username.toLowerCase().trim(),
        hash: hashPass(password).substring(0, 8) + '...'
    });
});

// ═══════════════════════════════════════════
// HEALTH & STATUS
// ═══════════════════════════════════════════

app.get('/', (req, res) => {
    res.json({
        service: '2AO Selfie',
        version: '2.0',
        status: 'running',
        activeTasks: Object.keys(tasks).length,
        activeVideos: Object.keys(videos).length,
        activeResults: Object.keys(results).length,
        uptime: Math.floor(process.uptime()) + 's'
    });
});

app.get('/health', (req, res) => {
    res.json({ ok: true, version: '2.0', timestamp: Date.now() });
});

app.get('/debug', (req, res) => {
    res.json({
        tasks: Object.keys(tasks).map(u => ({
            user: u,
            userId: (tasks[u].userId || '').substring(0, 10) + '...',
            age: Math.floor((Date.now() - tasks[u].timestamp) / 1000) + 's'
        })),
        videos: Object.keys(videos).map(u => ({
            user: u,
            format: videos[u].format,
            size: (videos[u].video.length / 1024).toFixed(0) + 'KB',
            age: Math.floor((Date.now() - videos[u].timestamp) / 1000) + 's'
        })),
        results: Object.keys(results).map(u => ({
            user: u,
            sid: (results[u].event_session_id || '').substring(0, 10) + '...',
            age: Math.floor((Date.now() - results[u].timestamp) / 1000) + 's'
        }))
    });
});

// ═══════════════════════════════════════════
// START
// ═══════════════════════════════════════════
app.listen(PORT, () => {
    console.log(`\n🔥 2AO Selfie Server v2.0`);
    console.log(`   Port: ${PORT}`);
    console.log(`   Max upload: 50MB`);
    console.log(`   Ready!\n`);
});
