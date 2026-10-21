#!/usr/bin/env node
'use strict';

/**
 * ysl-portal-auth —— teacher.yunshuling.com 的 Cookie 登录服务
 *
 * nginx 用 auth_request /_auth 校验；/login 提供表单页；/logout 退出。
 * 零依赖，数据落在 DATA_DIR（默认 ./data）。
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 8770);
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const SECRET_PATH = path.join(DATA_DIR, 'secret.key');
const COOKIE = 'ysl_auth';
const USER = 'teacher';
const FIXED_PASSWORD = process.env.PORTAL_PASSWORD || 'CHANGE_ME';
const SESSION_HOURS = Number(process.env.SESSION_HOURS || 12);
const IDLE_MINUTES = Number(process.env.IDLE_MINUTES || 30);
const seen = new Map();

if (FIXED_PASSWORD === 'CHANGE_ME') {
  console.warn('[auth] PORTAL_PASSWORD is not set; using CHANGE_ME');
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8' };

/* ------------------------------------------------------------------ */
/* 存储                                                                */
/* ------------------------------------------------------------------ */

function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadSecret() {
  try {
    return fs.readFileSync(SECRET_PATH, 'utf8').trim();
  } catch {
    const s = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(SECRET_PATH, s, { mode: 0o600 });
    return s;
  }
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function writeConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(plain, salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(plain) {
  if (!plain) return false;
  return safeEqual(plain, FIXED_PASSWORD);
}

ensureDirs();
const SECRET = loadSecret();
let config = readConfig();

function initPassword(plain) {
  const h = hashPassword(plain);
  config = { user: USER, salt: h.salt, hash: h.hash, version: Date.now() };
  writeConfig(config);
}

/* ------------------------------------------------------------------ */
/* 口令比较                                                            */
/* ------------------------------------------------------------------ */

function safeEqual(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

/* ------------------------------------------------------------------ */
/* Cookie 签名                                                         */
/* ------------------------------------------------------------------ */

function sign(exp) {
  return crypto.createHmac('sha256', SECRET).update(`portal:v4:${config.version}:${exp}`).digest('base64url');
}

function makeCookie(exp) {
  const token = `${exp}.${sign(exp)}`;
  // 会话 Cookie：不写 Max-Age，浏览器关闭即失效（手机端再由 IDLE_MINUTES 兜底）
  return { header: `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax`, token };
}

function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isAuthed(req) {
  if (!config) return false;
  const token = parseCookies(req)[COOKIE];
  if (!token) return false;
  const [expStr, sig] = token.split('.');
  const exp = Number(expStr);
  if (!exp || !sig || exp < Date.now()) return false;
  const want = sign(exp);
  if (sig.length !== want.length) return false;
  let ok = false;
  try {
    ok = crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want));
  } catch {
    return false;
  }
  if (!ok) return false;

  // 空闲超时：超过 IDLE_MINUTES 没有任何请求就要求重新登录
  const now = Date.now();
  const last = seen.get(token);
  if (last && now - last > IDLE_MINUTES * 60 * 1000) {
    seen.delete(token);
    return false;
  }
  seen.set(token, now);
  return true;
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

const hits = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 5 * 60 * 1000);
  if (arr.length >= 12) {
    hits.set(ip, arr);
    return true;
  }
  arr.push(now);
  hits.set(ip, arr);
  return false;
}

function clientIp(req) {
  const f = req.headers['x-real-ip'];
  if (typeof f === 'string' && f) return f;
  return req.socket.remoteAddress || '';
}

function safeNext(v) {
  const s = String(v || '');
  if (!s.startsWith('/') || s.startsWith('//') || /[\u0000-\u001f]/.test(s)) return '/';
  return s;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/* ------------------------------------------------------------------ */
/* 页面                                                                */
/* ------------------------------------------------------------------ */

function loginPage(next, error) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<title>访问口令 · Yunshuling Teacher Tools</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;
    font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;
    background:radial-gradient(900px 500px at 50% -180px,#e8eefc 0%,rgba(245,246,248,0) 70%),#f5f6f8;color:#0f172a}
  main{width:100%;max-width:400px;background:#fff;border:1px solid #e5e9f0;border-radius:20px;
    padding:28px 26px 24px;box-shadow:0 24px 60px -40px rgba(15,23,42,.5)}
  .logo{width:44px;height:44px;border-radius:13px;display:grid;place-items:center;color:#fff;font-weight:700;
    background:linear-gradient(135deg,#2563eb,#60a5fa);margin-bottom:16px;font-size:15px}
  h1{font-size:19px;margin:0 0 18px;letter-spacing:-.2px}
  .sub{font-size:12.5px;color:#64748b;line-height:1.65;margin:0 0 20px}
  label{display:block;font-size:12.5px;font-weight:600;color:#334155;margin:0 0 7px}
  input[type=password]{width:100%;height:50px;border:1px solid #e5e9f0;border-radius:12px;background:#fbfcfe;
    padding:0 14px;font-size:16px;outline:none;transition:border-color .2s,box-shadow .2s}
  input[type=password]:focus{border-color:#9db8f8;background:#fff;box-shadow:0 0 0 4px rgba(37,99,235,.08)}
  button{width:100%;height:50px;margin-top:16px;border:0;border-radius:12px;background:#2563eb;color:#fff;
    font-size:16px;font-weight:600;cursor:pointer;font-family:inherit}
  button:active{transform:scale(.99)}
  .err{margin:0 0 14px;padding:10px 12px;border-radius:10px;background:#fef2f2;border:1px solid #fecaca;
    color:#991b1b;font-size:12.5px;line-height:1.5}
  .foot{font-size:11.5px;color:#94a3b8;line-height:1.7;margin:18px 0 0;text-align:center}
  .foot a{color:#64748b}
</style>
</head>
<body>
<main>
  <div class="logo">云</div>
  <h1>教师工具 · 访问口令</h1>
  <p class="sub">输入后即可使用各卡片应用；人脸采集管理后台另有独立管理口令。</p>
  ${error ? '<p class="err">口令不正确，请重试。</p>' : ''}
  <form method="post" action="/login">
    <label for="pw">访问口令</label>
    <input id="pw" name="password" type="password" autocomplete="current-password" autofocus required>
    <input type="hidden" name="next" value="${esc(next)}">
    <button type="submit">进入</button>
  </form>
</main>
</body>
</html>`;
}

/* ------------------------------------------------------------------ */
/* 路由                                                                */
/* ------------------------------------------------------------------ */

function send(res, status, body, headers = {}) {
  const buf = Buffer.from(body, 'utf8');
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    ...headers
  });
  res.end(buf);
}

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (req.method === 'GET' && p === '/_auth') {
    if (isAuthed(req)) {
      res.writeHead(204, { 'X-Auth-User': USER, 'Cache-Control': 'no-store' });
      return res.end();
    }
    res.writeHead(401, { 'Cache-Control': 'no-store' });
    return res.end();
  }

  if (req.method === 'GET' && p === '/login') {
    const next = safeNext(url.searchParams.get('next') || '/');
    return send(res, 200, loginPage(next, url.searchParams.get('e') === '1'));
  }

  if (req.method === 'POST' && p === '/login') {
    const ip = clientIp(req);
    if (rateLimited(ip)) {
      return send(res, 429, loginPage('/', false).replace('输入访问口令', '尝试过于频繁，请 5 分钟后再试'));
    }
    let form;
    try {
      form = new URLSearchParams(await readBody(req));
    } catch {
      return send(res, 400, 'bad request');
    }
    const password = form.get('password') || '';
    const next = safeNext(form.get('next') || '/');
    if (!verifyPassword(password)) {
      return send(res, 302, '', { Location: `/login?e=1&next=${encodeURIComponent(next)}` });
    }
    const exp = Date.now() + SESSION_HOURS * 3600 * 1000;
    const c = makeCookie(exp);
    seen.set(c.token, Date.now());
    return send(res, 302, '', { Location: next, 'Set-Cookie': c.header });
  }

  if ((req.method === 'GET' || req.method === 'POST') && p === '/logout') {
    return send(res, 302, '', { Location: '/login', 'Set-Cookie': clearCookie() });
  }

  if (p === '/healthz') {
    return send(res, 200, 'ok', { 'Content-Type': 'text/plain; charset=utf-8' });
  }

  send(res, 404, 'not found');
}

/* ------------------------------------------------------------------ */
/* 启动 / CLI                                                          */
/* ------------------------------------------------------------------ */

const args = process.argv.slice(2);
if (args[0] === '--set-password') {
  const pw = args[1] || '';
  if (pw.length < 6) {
    console.error('密码至少 6 位');
    process.exit(1);
  }
  initPassword(pw);
  console.log('密码已更新（旧 Cookie 立即失效）');
  process.exit(0);
}

if (!config) {
  const pw = process.env.INIT_PASSWORD;
  if (!pw) {
    console.error('没有密码配置：先运行 node server.js --set-password <口令>');
    process.exit(1);
  }
  initPassword(pw);
}

// 定期清理过期的空闲记录（防止 Map 无限增长）
setInterval(() => {
  const cutoff = Date.now() - IDLE_MINUTES * 60 * 1000 * 2;
  for (const [k, t] of seen) if (t < cutoff) seen.delete(k);
}, 10 * 60 * 1000).unref();

const server = http.createServer((req, res) => {
  route(req, res).catch((err) => {
    console.error('[auth]', err.message);
    if (!res.headersSent) send(res, 500, 'server error');
  });
});

server.listen(PORT, HOST, () => {
  console.log(`portal-auth listening on http://${HOST}:${PORT}`);
});
