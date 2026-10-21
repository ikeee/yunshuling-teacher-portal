#!/usr/bin/env node
'use strict';

/**
 * face-collect —— 手机端人脸信息采集 + 管理导出（零依赖 Node 服务）
 *
 *  - 手机端：摄像头取景 / 相册上传 → 填写姓名、部门、手机号 → 提交
 *  - 管理端：查看、搜索、标记已导入、导出 ZIP（照片 + CSV）用于导入人脸设备
 *  - 数据落盘：data/records/*.json + data/photos/*.jpg，全部本地，无云依赖
 */

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const zlib = require('node:zlib');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = process.env.FC_DATA_DIR ? path.resolve(process.env.FC_DATA_DIR) : path.join(ROOT, 'data');
const PHOTO_DIR = path.join(DATA_DIR, 'photos');
const RECORD_DIR = path.join(DATA_DIR, 'records');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const PASSWORD_FILE = path.join(DATA_DIR, 'admin-password.txt');
const SECRET_PATH = path.join(DATA_DIR, 'secret.key');
const AUDIT_PATH = path.join(DATA_DIR, 'audit.jsonl');
const EXPORT_STATS_PATH = path.join(DATA_DIR, 'export-stats.json');
const CERT_DIR = path.join(ROOT, 'certs');

const HTTP_PORT = Number(process.env.PORT || 8090);
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 8443);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_BODY = 12 * 1024 * 1024;
const MAX_PHOTO = 8 * 1024 * 1024;
const SESSION_HOURS = 12;

const DEFAULT_CONFIG = {
  title: '人脸信息采集',
  subtitle: '请填写基本信息并拍摄一张正面照片，用于门禁人脸录入。',
  open: true,
  accessCode: '',
  deptLabel: '部门',
  deptRequired: true,
  deptOptions: ['教职工', '教辅', '保安员', '保洁员', '食堂'],
  photoWidth: 480,
  photoHeight: 640,
  retentionNote: '人脸属于敏感个人信息，仅用于人脸设备录入，导入完成后由管理员统一删除。',
  adminPasswordHash: '',
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.mjs': 'application/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
};

/* ------------------------------------------------------------------ */
/* 基础设施                                                            */
/* ------------------------------------------------------------------ */

function ensureDirs() {
  for (const dir of [DATA_DIR, PHOTO_DIR, RECORD_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function loadSecret() {
  try {
    return fs.readFileSync(SECRET_PATH, 'utf8').trim();
  } catch {
    const secret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(SECRET_PATH, secret, { mode: 0o600 });
    return secret;
  }
}

const SECRET = (ensureDirs(), loadSecret());

let config = loadConfig();

function loadConfig() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    saved = {};
  }
  return { ...DEFAULT_CONFIG, ...saved };
}

async function saveConfig() {
  const tmp = CONFIG_PATH + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(config, null, 2), 'utf8');
  await fsp.rename(tmp, CONFIG_PATH);
}

function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(plain, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(plain, stored) {
  try {
    const [algo, salt, hash] = String(stored).split('$');
    if (algo !== 'scrypt' || !salt || !hash) return false;
    const got = crypto.scryptSync(plain, salt, 64);
    const want = Buffer.from(hash, 'hex');
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  } catch {
    return false;
  }
}

function initAdminPassword() {
  if (config.adminPasswordHash) return;
  const plain = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
  config.adminPasswordHash = hashPassword(plain);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
  fs.writeFileSync(
    PASSWORD_FILE,
    `管理员密码: ${plain}\n生成时间: ${new Date().toISOString()}\n\n` +
      `修改方法：删除 data/config.json 里的 adminPasswordHash 字段后重启，\n` +
      `或用环境变量 ADMIN_PASSWORD 重新初始化。\n`,
    'utf8'
  );
  console.log('\n  ── 已生成管理员密码 ─────────────────────────────');
  console.log(`     密码: ${plain}`);
  console.log(`     已保存到 ${PASSWORD_FILE}`);
  console.log('  ────────────────────────────────────────────────\n');
}

const ipHits = new Map();

function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  const arr = (ipHits.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= limit) {
    ipHits.set(key, arr);
    return false;
  }
  arr.push(now);
  ipHits.set(key, arr);
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, arr] of ipHits) {
    const kept = arr.filter((t) => now - t < 60 * 60 * 1000);
    if (kept.length) ipHits.set(key, kept);
    else ipHits.delete(key);
  }
}, 10 * 60 * 1000).unref();

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress || '';
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

function signSession(exp) {
  return crypto.createHmac('sha256', SECRET).update(`admin:${exp}`).digest('base64url');
}

function isAdmin(req) {
  const cookies = parseCookies(req);
  const token = cookies.fc_sid;
  if (!token) return false;
  const [expStr, sig] = token.split('.');
  const exp = Number(expStr);
  if (!exp || !sig || exp < Date.now()) return false;
  const want = signSession(exp);
  if (sig.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want));
}

function sessionCookie(exp) {
  const token = `${exp}.${signSession(exp)}`;
  const maxAge = Math.floor((exp - Date.now()) / 1000);
  return `fc_sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  const payload = isBuf ? body : Buffer.from(String(body), 'utf8');
  res.writeHead(status, {
    'Content-Length': payload.length,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    ...headers,
  });
  res.end(payload);
}

function sendJson(res, status, obj, headers = {}) {
  send(res, status, JSON.stringify(obj), {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!size) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('invalid json'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function readExportStats() {
  try {
    const st = JSON.parse(fs.readFileSync(EXPORT_STATS_PATH, 'utf8'));
    return {
      count: Number(st.count) || 0,
      lastAt: st.lastAt || null,
      lastCount: Number(st.lastCount) || 0,
    };
  } catch {
    return { count: 0, lastAt: null, lastCount: 0 };
  }
}

function writeExportStats(st) {
  try {
    fs.writeFileSync(EXPORT_STATS_PATH, JSON.stringify(st, null, 2), 'utf8');
  } catch (err) {
    console.error('[export-stats] write failed:', err.message);
  }
}

async function audit(action, extra = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), action, ...extra }) + '\n';
  try {
    await fsp.appendFile(AUDIT_PATH, line, 'utf8');
  } catch (err) {
    console.error('[audit] write failed:', err.message);
  }
}

/* ------------------------------------------------------------------ */
/* 记录存储                                                            */
/* ------------------------------------------------------------------ */

const phoneIndex = new Map(); // 手机号（去符号）-> record id
let recordCache = new Map(); // id -> record

function phoneKey(value) {
  return String(value || '').replace(/\D/g, '');
}

async function loadRecords() {
  const files = await fsp.readdir(RECORD_DIR).catch(() => []);
  const map = new Map();
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const rec = JSON.parse(await fsp.readFile(path.join(RECORD_DIR, file), 'utf8'));
      if (rec && rec.id) map.set(rec.id, rec);
    } catch {
      /* 忽略损坏文件 */
    }
  }
  recordCache = map;
  phoneIndex.clear();
  for (const rec of map.values()) {
    const key = phoneKey(rec.phone);
    if (key) phoneIndex.set(key, rec.id);
  }
}

async function writeRecord(rec) {
  const file = path.join(RECORD_DIR, `${rec.id}.json`);
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(rec, null, 2), 'utf8');
  await fsp.rename(tmp, file);
  recordCache.set(rec.id, rec);
  const key = phoneKey(rec.phone);
  if (key) phoneIndex.set(key, rec.id);
}

function listRecords() {
  return [...recordCache.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

function publicRecord(rec) {
  return {
    id: rec.id,
    name: rec.name,
    dept: rec.dept || '',
    phone: rec.phone || '',
    width: rec.width,
    height: rec.height,
    size: rec.size,
    status: rec.status || 'pending',
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    checks: rec.checks || {},
  };
}

/* ------------------------------------------------------------------ */
/* 校验工具                                                            */
/* ------------------------------------------------------------------ */

function cleanText(v, max = 40) {
  return String(v == null ? '' : v)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, max);
}

function jpegInfo(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  if (buf[buf.length - 2] !== 0xff || buf[buf.length - 1] !== 0xd9) return null;
  let i = 2;
  while (i < buf.length - 9) {
    if (buf[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = buf[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker === 0xda) break;
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    if (len < 2) break;
    i += 2 + len;
  }
  return null;
}

function decodePhoto(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const m = /^data:image\/jpe?g;base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl);
  if (!m) return null;
  let buf;
  try {
    buf = Buffer.from(m[1].replace(/\s+/g, ''), 'base64');
  } catch {
    return null;
  }
  if (buf.length < 2048 || buf.length > MAX_PHOTO) return null;
  const info = jpegInfo(buf);
  if (!info || info.width < 120 || info.height < 120) return null;
  return { buf, ...info };
}

/* ------------------------------------------------------------------ */
/* JSON 接口                                                           */
/* ------------------------------------------------------------------ */

async function handleConfigGet(res) {
  sendJson(res, 200, {
    title: config.title,
    subtitle: config.subtitle,
    open: config.open,
    accessCodeRequired: Boolean(config.accessCode),
    deptLabel: config.deptLabel,
    deptRequired: config.deptRequired,
    deptOptions: config.deptOptions,
    photoWidth: config.photoWidth,
    photoHeight: config.photoHeight,
    retentionNote: config.retentionNote,
  });
}

async function handleSubmit(req, res) {
  const ip = clientIp(req);
  if (!rateLimit(`submit:${ip}`, 400, 60 * 60 * 1000)) {
    return sendJson(res, 429, { error: '提交过于频繁，请稍后再试' });
  }
  if (!config.open) {
    return sendJson(res, 403, { error: '当前未开放采集，请联系管理员' });
  }

  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    return sendJson(res, err.status || 400, { error: err.status === 413 ? '照片太大，请重拍' : '请求格式错误' });
  }

  if (config.accessCode) {
    const code = cleanText(body.code, 32);
    const a = Buffer.from(code);
    const b = Buffer.from(config.accessCode);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return sendJson(res, 403, { error: '访问码不正确' });
    }
  }

  if (body.consent !== true) {
    return sendJson(res, 400, { error: '请先勾选同意条款' });
  }

  const name = cleanText(body.name, 30);
  if (!name) return sendJson(res, 400, { error: '请填写姓名' });

  const dept = cleanText(body.dept, 60);
  if (config.deptRequired && !dept) return sendJson(res, 400, { error: `请选择${config.deptLabel}` });
  if (dept && config.deptOptions.length && config.deptOptions.indexOf(dept) < 0) {
    return sendJson(res, 400, { error: '请从下拉列表中选择部门' });
  }

  const phone = cleanText(body.phone, 20);
  if (!phone) return sendJson(res, 400, { error: '请填写手机号' });
  if (!/^[0-9+\-\s()]{5,20}$/.test(phone)) return sendJson(res, 400, { error: '手机号格式不正确' });

  const photo = decodePhoto(body.photo);
  if (!photo) return sendJson(res, 400, { error: '照片无效，请重新拍摄（需要 JPG 格式）' });

  const key = phoneKey(phone);
  const existingId = key ? phoneIndex.get(key) : null;
  if (existingId && body.overwrite !== true) {
    const existing = recordCache.get(existingId);
    return sendJson(res, 409, {
      code: 'EXISTS',
      error: '该手机号已提交过',
      existingName: existing ? existing.name : '',
      existingAt: existing ? existing.createdAt : '',
    });
  }

  const now = new Date().toISOString();
  const id = existingId || crypto.randomBytes(8).toString('hex');
  const photoName = `${id}.jpg`;
  const file = path.join(PHOTO_DIR, photoName);
  await fsp.writeFile(file, photo.buf);

  const prev = existingId ? recordCache.get(existingId) : null;
  const rec = {
    id,
    name,
    dept,
    phone,
    photo: photoName,
    width: photo.width,
    height: photo.height,
    size: photo.buf.length,
    status: 'pending',
    createdAt: prev ? prev.createdAt : now,
    updatedAt: now,
    checks: body.checks && typeof body.checks === 'object' ? body.checks : {},
    ua: cleanText(req.headers['user-agent'], 200),
    ip,
  };
  await writeRecord(rec);
  await audit(existingId ? 'overwrite' : 'submit', { id, name, phone, ip });

  sendJson(res, 200, { ok: true, id, overwritten: Boolean(existingId) });
}

async function handleLogin(req, res) {
  const ip = clientIp(req);
  if (!rateLimit(`login:${ip}`, 10, 5 * 60 * 1000)) {
    return sendJson(res, 429, { error: '尝试次数过多，请 5 分钟后再试' });
  }
  const body = await readBody(req, 64 * 1024).catch(() => ({}));
  const password = String(body.password || '');
  if (!verifyPassword(password, config.adminPasswordHash)) {
    await audit('login_fail', { ip });
    return sendJson(res, 401, { error: '密码错误' });
  }
  const exp = Date.now() + SESSION_HOURS * 3600 * 1000;
  await audit('login_ok', { ip });
  sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(exp) });
}

function requireAdmin(req, res) {
  if (isAdmin(req)) return true;
  sendJson(res, 401, { error: '未登录或登录已过期' });
  return false;
}

async function handleAdminList(req, res, url) {
  if (!requireAdmin(req, res)) return;
  const q = (url.searchParams.get('q') || '').trim().toLowerCase();
  const status = url.searchParams.get('status') || 'all';

  let items = listRecords();
  if (status === 'pending' || status === 'imported') {
    items = items.filter((r) => (r.status || 'pending') === status);
  }
  if (q) {
    items = items.filter((r) =>
      [r.name, r.dept, r.phone].filter(Boolean).some((v) => String(v).toLowerCase().includes(q))
    );
  }

  const today = shanghaiDateKey(new Date());
  const all = listRecords();
  const stats = {
    total: all.length,
    imported: all.filter((r) => r.status === 'imported').length,
    pending: all.filter((r) => (r.status || 'pending') === 'pending').length,
    today: all.filter((r) => shanghaiDateKey(new Date(r.createdAt)) === today).length,
    exports: readExportStats(),
  };

  sendJson(res, 200, { items: items.map(publicRecord), stats });
}

async function handleAdminPhoto(req, res, url) {
  if (!requireAdmin(req, res)) return;
  const id = String(url.searchParams.get('id') || '');
  if (!/^[a-f0-9]{16}$/.test(id)) return send(res, 400, 'bad id');
  const file = path.join(PHOTO_DIR, `${id}.jpg`);
  try {
    const buf = await fsp.readFile(file);
    send(res, 200, buf, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=300' });
  } catch (err) {
    console.error('[static]', file, err && err.message);
    send(res, 404, 'not found');
  }
}

async function handleAdminUpdate(req, res) {
  if (!requireAdmin(req, res)) return;
  const body = await readBody(req, 64 * 1024).catch(() => null);
  if (!body || !body.id) return sendJson(res, 400, { error: '参数错误' });
  const rec = recordCache.get(String(body.id));
  if (!rec) return sendJson(res, 404, { error: '记录不存在' });

  if (body.status === 'pending' || body.status === 'imported') rec.status = body.status;
  if (body.name !== undefined) {
    const name = cleanText(body.name, 30);
    if (!name) return sendJson(res, 400, { error: '姓名不能为空' });
    rec.name = name;
  }
  if (body.dept !== undefined) {
    const dept = cleanText(body.dept, 60);
    if (!dept && config.deptRequired) return sendJson(res, 400, { error: `请选择${config.deptLabel}` });
    if (dept && config.deptOptions.length && config.deptOptions.indexOf(dept) < 0) {
      return sendJson(res, 400, { error: '请从下拉列表中选择部门' });
    }
    rec.dept = dept;
  }
  if (body.phone !== undefined) {
    const phone = cleanText(body.phone, 20);
    if (!phone) return sendJson(res, 400, { error: '请填写手机号' });
    if (!/^[0-9+\-\s()]{5,20}$/.test(phone)) return sendJson(res, 400, { error: '手机号格式不正确' });
    const key = phoneKey(phone);
    const clash = phoneIndex.get(key);
    if (clash && clash !== rec.id) return sendJson(res, 409, { error: '该手机号已被其他记录使用' });
    const oldKey = phoneKey(rec.phone);
    if (oldKey && oldKey !== key) phoneIndex.delete(oldKey);
    rec.phone = phone;
    phoneIndex.set(key, rec.id);
  }
  rec.updatedAt = new Date().toISOString();

  await writeRecord(rec);
  await audit('update', { id: rec.id, fields: Object.keys(body) });
  sendJson(res, 200, { ok: true, item: publicRecord(rec) });
}

async function handleAdminDelete(req, res) {
  if (!requireAdmin(req, res)) return;
  const body = await readBody(req, 64 * 1024).catch(() => null);
  if (!body || !body.id) return sendJson(res, 400, { error: '参数错误' });
  const id = String(body.id);
  const rec = recordCache.get(id);
  if (!rec) return sendJson(res, 404, { error: '记录不存在' });

  await fsp.unlink(path.join(RECORD_DIR, `${id}.json`)).catch(() => {});
  await fsp.unlink(path.join(PHOTO_DIR, `${id}.jpg`)).catch(() => {});
  recordCache.delete(id);
  const key = phoneKey(rec.phone);
  if (key) phoneIndex.delete(key);
  await audit('delete', { id, name: rec.name });
  sendJson(res, 200, { ok: true });
}

async function handleAdminSettingsGet(req, res) {
  if (!requireAdmin(req, res)) return;
  const { adminPasswordHash, ...safe } = config;
  const httpsReady =
    fs.existsSync(path.join(CERT_DIR, 'server.crt')) && fs.existsSync(path.join(CERT_DIR, 'server.key'));
  sendJson(res, 200, {
    ...safe,
    hasPassword: Boolean(adminPasswordHash),
    urls: {
      lan: lanAddresses(),
      httpPort: HTTP_PORT,
      httpsPort: httpsReady ? HTTPS_PORT : null,
    },
  });
}

async function handleAdminSettingsPost(req, res) {
  if (!requireAdmin(req, res)) return;
  const body = await readBody(req, 64 * 1024).catch(() => null);
  if (!body) return sendJson(res, 400, { error: '参数错误' });

  if (typeof body.title === 'string') config.title = cleanText(body.title, 40) || DEFAULT_CONFIG.title;
  if (typeof body.subtitle === 'string') config.subtitle = cleanText(body.subtitle, 160);
  if (typeof body.open === 'boolean') config.open = body.open;
  if (typeof body.accessCode === 'string') config.accessCode = cleanText(body.accessCode, 32);
  if (typeof body.deptLabel === 'string') config.deptLabel = cleanText(body.deptLabel, 20) || '部门';
  if (typeof body.deptRequired === 'boolean') config.deptRequired = body.deptRequired;
  if (typeof body.deptOptions === 'string') {
    const list = body.deptOptions
      .split(/[,，、\n]/)
      .map((s) => cleanText(s, 20))
      .filter(Boolean);
    if (list.length) config.deptOptions = [...new Set(list)].slice(0, 20);
  }
  if (typeof body.retentionNote === 'string') config.retentionNote = cleanText(body.retentionNote, 300);
  if (body.newPassword) {
    const pwd = String(body.newPassword);
    if (pwd.length < 6) return sendJson(res, 400, { error: '新密码至少 6 位' });
    config.adminPasswordHash = hashPassword(pwd);
    fs.writeFileSync(PASSWORD_FILE, `管理员密码已于 ${new Date().toISOString()} 修改（内容不再留档）\n`, 'utf8');
  }

  await saveConfig();
  await audit('settings', { open: config.open });
  sendJson(res, 200, { ok: true });
}

/* ------------------------------------------------------------------ */
/* 导出：ZIP + CSV                                                     */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const d = date instanceof Date ? date : new Date();
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const data = entry.data;
    const crc = crc32(data);
    const { time, date } = dosDateTime(entry.mtime);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    local.writeUInt16LE(0, 8); // store
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

function csvCell(value) {
  const s = value == null ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function safeFileName(value, fallback) {
  const s = String(value || '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
  return s || fallback;
}

function photoFileName(rec, naming) {
  const name = safeFileName(rec.name, `id-${rec.id.slice(0, 6)}`);
  const phone = phoneKey(rec.phone);
  if (naming === 'name_phone') return phone ? `${name}_${phone.slice(-4)}` : name;
  if (naming === 'id') return rec.id.slice(0, 8);
  return name;
}

function shanghaiDateKey(date) {
  const d = date instanceof Date ? date : new Date(date);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function shanghaiTime(iso) {
  if (!iso) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
    .format(new Date(iso))
    .replace(/\//g, '-');
}

function buildCsv(records, format, naming, fileById) {
  const headerGeneric = ['姓名', '部门', '手机', '照片文件', '采集时间'];
  const headerDevice = ['姓名', '部门', '手机', '照片文件'];
  const header = format === 'device' ? headerDevice : headerGeneric;
  const lines = [header.map(csvCell).join(',')];
  for (const rec of records) {
    const file = `${(fileById && fileById.get(rec.id)) || photoFileName(rec, naming)}.jpg`;
    const row =
      format === 'device'
        ? [rec.name || '', rec.dept || '', rec.phone || '', `photos/${file}`]
        : [
            rec.name || '',
            rec.dept || '',
            rec.phone || '',
            `photos/${file}`,
            shanghaiTime(rec.createdAt),
          ];
    lines.push(row.map(csvCell).join(','));
  }
  return Buffer.from('\uFEFF' + lines.join('\r\n') + '\r\n', 'utf8');
}

function buildReadme(records, format, naming) {
  const namingText =
    naming === 'name_phone'
      ? '以「姓名_手机后4位」命名'
      : naming === 'id'
        ? '以内部编号命名'
        : '以「姓名」命名';
  return Buffer.from(
    [
      '人脸信息导入包',
      '================',
      '',
      `导出时间：${shanghaiTime(new Date().toISOString())}`,
      `记录数量：${records.length}`,
      `CSV 格式：${format === 'device' ? '门禁设备常用列' : '通用列（带采集时间）'}`,
      `照片命名：${namingText}`,
      '',
      '文件说明',
      '--------',
      '1. persons.csv —— 人员信息表（UTF-8 带 BOM，Excel 可直接双击打开不乱码）。',
      '2. photos/    —— 人脸照片，JPG，默认 480×640。文件名与 CSV 的「照片文件」列一致。',
      '3. data.json  —— 原始字段的完整备份（含采集时间、状态）。',
      '',
      '导入设备的一般步骤',
      '------------------',
      '1. 先在设备厂商的客户端/Web 后台里找到「人员导入」或「批量导入」。',
      '2. 下载该型号自带的 Excel 模板，把 persons.csv 的列按模板表头对应粘贴。',
      '   （各品牌型号的列名、必填项、照片规格要求不同，务必以设备模板为准。）',
      '3. 照片按模板要求命名，通常为「姓名.jpg」，同名人员会自动加 -2、-3 区分。',
      '4. 若设备只支持 U 盘导入，按其目录要求把 photos/ 放到指定目录。',
      '',
      '注意',
      '----',
      '· 本包含生物识别信息，请勿通过公开网盘/群聊转发，导入完成后及时删除。',
      '· 建议导入前抽查 3~5 张照片，确认清晰度与命名对应关系。',
      '',
    ].join('\r\n'),
    'utf8'
  );
}

async function handleExport(req, res, url) {
  if (!requireAdmin(req, res)) return;
  const scope = url.searchParams.get('scope') || 'all';
  const naming = url.searchParams.get('naming') || 'name';
  const format = url.searchParams.get('format') === 'device' ? 'device' : 'generic';
  const q = (url.searchParams.get('q') || '').trim().toLowerCase();

  let records = listRecords();
  if (scope === 'pending' || scope === 'imported') {
    records = records.filter((r) => (r.status || 'pending') === scope);
  }
  if (q) {
    records = records.filter((r) =>
      [r.name, r.dept, r.phone].filter(Boolean).some((v) => String(v).toLowerCase().includes(q))
    );
  }
  if (!records.length) return sendJson(res, 400, { error: '没有可导出的记录' });

  const entries = [];
  const used = new Set();
  const fileById = new Map();
  const included = [];
  for (const rec of records) {
    let base = photoFileName(rec, naming);
    let candidate = base;
    let n = 2;
    while (used.has(candidate.toLowerCase())) candidate = `${base}-${n++}`;
    used.add(candidate.toLowerCase());

    let data;
    try {
      data = await fsp.readFile(path.join(PHOTO_DIR, `${rec.id}.jpg`));
    } catch {
      continue;
    }
    fileById.set(rec.id, candidate);
    included.push(rec);
    entries.push({ name: `photos/${candidate}.jpg`, data, mtime: new Date(rec.updatedAt || rec.createdAt) });
  }

  if (!included.length) return sendJson(res, 400, { error: '照片文件缺失，没有可导出的记录' });

  // 导出即视为已交付：自动标记为「已导出」，并累计导出次数
  const nowIso = new Date().toISOString();
  for (const rec of included) {
    rec.status = 'imported';
    rec.exportedAt = nowIso;
    try {
      await writeRecord(rec);
    } catch (err) {
      console.error('[export] mark failed:', rec.id, err.message);
    }
  }
  const st = readExportStats();
  st.count += 1;
  st.lastAt = nowIso;
  st.lastCount = included.length;
  writeExportStats(st);

  entries.push({ name: 'persons.csv', data: buildCsv(included, format, naming, fileById), mtime: new Date() });
  entries.push({
    name: 'data.json',
    data: Buffer.from(JSON.stringify(included.map(publicRecord), null, 2), 'utf8'),
    mtime: new Date(),
  });
  entries.push({ name: 'README.txt', data: buildReadme(included, format, naming), mtime: new Date() });

  const zip = buildZip(entries);
  const stamp = shanghaiDateKey(new Date()).replace(/-/g, '') + '-' + String(new Date().getHours()).padStart(2, '0') + String(new Date().getMinutes()).padStart(2, '0');
  const fileName = `face-export-${stamp}.zip`;

  await audit('export', { count: included.length, scope, naming, format });
  send(res, 200, zip, {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    'Cache-Control': 'no-store',
  });
}

/* ------------------------------------------------------------------ */
/* 静态文件 + 路由                                                     */
/* ------------------------------------------------------------------ */

const gzipCache = new Map();

function gzipOf(file, mtimeMs, data) {
  const key = `${file}|${mtimeMs}`;
  let gz = gzipCache.get(key);
  if (!gz) {
    gz = zlib.gzipSync(data, { level: 6 });
    if (gzipCache.size > 40) gzipCache.clear();
    gzipCache.set(key, gz);
  }
  return gz;
}

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = path.resolve(PUBLIC_DIR, rel);
  if (!target.startsWith(path.resolve(PUBLIC_DIR) + path.sep) && target !== path.resolve(PUBLIC_DIR)) {
    return send(res, 403, 'forbidden');
  }
  let file = target;
  let stat;
  try {
    stat = await fsp.stat(file);
    if (stat.isDirectory()) file = path.join(file, 'index.html');
  } catch {
    return send(res, 404, 'not found');
  }
  const ext = path.extname(file).toLowerCase();
  const contentType = MIME[ext] || (ext === '' ? 'application/octet-stream' : '');
  if (!contentType) return send(res, 404, 'not found');
  try {
    const data = await fsp.readFile(file);
    const headers = {
      'Content-Type': contentType,
      'Cache-Control': pathname.startsWith('/vendor/')
        ? 'public, max-age=31536000, immutable'
        : ext === '.html'
          ? 'no-cache'
          : 'public, max-age=3600',
      Vary: 'Accept-Encoding',
    };
    let body = data;
    const acceptsGzip = /\bgzip\b/i.test(String(req.headers['accept-encoding'] || ''));
    if (acceptsGzip && data.length > 1024 && /\.(html|css|js|mjs|json|svg|wasm|task)$/i.test(ext)) {
      body = gzipOf(file, stat.mtimeMs, data);
      headers['Content-Encoding'] = 'gzip';
    }
    send(res, 200, body, headers);
  } catch {
    send(res, 404, 'not found');
  }
}

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;

  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' blob: 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'"
  );

  try {
    if (req.method === 'GET' && pathname === '/api/config') return await handleConfigGet(res);
    if (req.method === 'POST' && pathname === '/api/submit') return await handleSubmit(req, res);
    if (req.method === 'POST' && pathname === '/api/login') return await handleLogin(req, res);
    if (req.method === 'POST' && pathname === '/api/logout') {
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': 'fc_sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' });
    }
    if (req.method === 'GET' && pathname === '/api/admin/session') {
      return sendJson(res, 200, { admin: isAdmin(req) });
    }
    if (req.method === 'GET' && pathname === '/api/admin/list') return await handleAdminList(req, res, url);
    if (req.method === 'GET' && pathname === '/api/admin/photo') return await handleAdminPhoto(req, res, url);
    if (req.method === 'POST' && pathname === '/api/admin/update') return await handleAdminUpdate(req, res);
    if (req.method === 'POST' && pathname === '/api/admin/delete') return await handleAdminDelete(req, res);
    if (req.method === 'GET' && pathname === '/api/admin/export') return await handleExport(req, res, url);
    if (req.method === 'GET' && pathname === '/api/admin/settings') return await handleAdminSettingsGet(req, res);
    if (req.method === 'POST' && pathname === '/api/admin/settings') return await handleAdminSettingsPost(req, res);
    if (req.method === 'GET' && pathname === '/healthz') return sendJson(res, 200, { ok: true });

    if (req.method === 'GET' && (pathname === '/admin' || pathname === '/admin/')) {
      return await serveStatic(req, res, '/admin.html');
    }
    if (req.method === 'GET') return await serveStatic(req, res, pathname);
    send(res, 405, 'method not allowed');
  } catch (err) {
    console.error('[error]', err);
    if (!res.headersSent) sendJson(res, 500, { error: '服务端错误' });
  }
}

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item.family === 'IPv4' && !item.internal) out.push(item.address);
    }
  }
  return out;
}

async function main() {
  initAdminPassword();
  await loadRecords();

  const server = http.createServer((req, res) => route(req, res));
  server.on('error', (err) => {
    console.error(`HTTP 端口 ${HTTP_PORT} 启动失败：${err.message}`);
    process.exit(1);
  });
  server.listen(HTTP_PORT, HOST, () => {
    console.log(`\n  人脸采集服务已启动`);
    console.log(`  采集页  http://localhost:${HTTP_PORT}/`);
    for (const ip of lanAddresses()) console.log(`  局域网  http://${ip}:${HTTP_PORT}/`);
    console.log(`  管理页  http://localhost:${HTTP_PORT}/admin`);
  });

  const certPath = path.join(CERT_DIR, 'server.crt');
  const keyPath = path.join(CERT_DIR, 'server.key');
  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    const httpsServer = https.createServer(
      { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) },
      (req, res) => route(req, res)
    );
    httpsServer.on('error', (err) => {
      console.error(`HTTPS 端口 ${HTTPS_PORT} 启动失败：${err.message}（已跳过 HTTPS，HTTP 仍可用）`);
    });
    httpsServer.listen(HTTPS_PORT, HOST, () => {
      console.log(`  HTTPS   https://localhost:${HTTPS_PORT}/`);
      for (const ip of lanAddresses()) console.log(`  HTTPS   https://${ip}:${HTTPS_PORT}/`);
      console.log('');
    });
  } else {
    console.log('\n  提示：未找到 certs/server.crt|key，HTTPS 未启用。');
    console.log('        手机浏览器调用摄像头需要 HTTPS，可运行 scripts\\make-cert.ps1 生成本地证书，');
    console.log('        或部署到已有 HTTPS 域名的服务器上。\n');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
