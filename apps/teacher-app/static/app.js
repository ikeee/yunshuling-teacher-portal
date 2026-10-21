/* 云树灵 · B站下载器 前端逻辑 */
const $ = (id) => document.getElementById(id);
/* 两个引擎共用这一份 JS，但服务端会把不属于本引擎的整段 HTML 剥掉（防"首屏闪对方内容"）。
   所以任何对引擎专属节点的绑定都必须判空 —— 裸写 $('mode').onclick 的代价不是"少个按钮"，
   而是抛异常后**后面所有绑定与初始化全部不执行**（2026-10-16 在 /xhs/ 上真踩到：
   页面看着正常，"开始下载"点了没反应）。 */
const on = (id, ev, fn) => { const e = $(id); if (e) e.addEventListener(ev, fn); return e; };
const bind = (id, fn) => { const e = $(id); if (e) e.onclick = fn; return e; };
const setText = (id, t) => { const e = $(id); if (e) e.textContent = t; };
const setHidden = (id, h) => { const e = $(id); if (e) e.hidden = h; };
let mode = 'video';
let curJob = null, timer = null;

/* ---------- 工具 ---------- */
/* 页内提示条：替代原生 alert()（原生弹窗会阻塞、样式突兀、手机上还会被拦） */
let TOAST_T = null;
function toast(msg, kind) {
  const el = $('toast');
  if (!el) { alert(msg); return; }
  el.textContent = String(msg == null ? '' : msg);
  el.className = 'toast show' + (kind === 'ok' ? ' ok' : '');
  clearTimeout(TOAST_T);
  TOAST_T = setTimeout(() => { el.className = 'toast'; }, 7000);
}

function fmtBytes(n) {
  if (!n && n !== 0) return '—';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return v.toFixed(v >= 100 || i === 0 ? 0 : 1) + ' ' + u[i];
}
function fmtTime(s) {
  if (s == null) return '—';
  const m = Math.floor(s / 60), r = Math.round(s % 60);
  return m > 0 ? YSLLang.T('min_sec', { m: m, s: r }) : YSLLang.T('sec', { s: r });
}
function fmtDate(ts) {
  const d = new Date(ts * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
async function api(path, opt) {
  opt = opt || {};
  opt.headers = Object.assign({}, opt.headers || {});
  if (ADMIN_TOKEN) opt.headers['X-Admin-Token'] = ADMIN_TOKEN;
  const r = await fetch(path, opt);
  return await r.json();
}

/* 管理口令解锁（公开部署时，扫码登录/改目录需要） */
document.addEventListener('DOMContentLoaded', () => {
  const btn = $('btn-unlock');
  if (!btn) return;
  btn.onclick = async () => {
    ADMIN_TOKEN = ($('admin-pass').value || '').trim();
    localStorage.setItem('ysl_admin', ADMIN_TOKEN);
    await loadStatus();
    if (!$('btn-login').hidden) $('quota-line').textContent = YSLLang.T('admin_ok');
    else toast(YSLLang.T('admin_bad'));
  };
});

/* ---------- 环境 ---------- */
let IS_PUBLIC = false;
let IS_ADMIN = false;
let ADMIN_TOKEN = localStorage.getItem('ysl_admin') || '';
// bili | xhs：优先用服务端注入的 <body data-engine>（首屏即确定），/api/status 回来后再对齐一次
let ENGINE = (document.body && document.body.dataset.engine) || 'bili';
let RETENTION_SEC = 3600;     // 文件保留时长（秒），来自 /api/status，用于"还剩多久"倒计时

async function loadStatus() {
  const s = await api('api/status');
  /* 顶栏那个"引擎版本 + 磁盘余量"角标已按要求移除；
     但"引擎不可用"这个告警不能丢，改成只在出错时出现在提示条里 */
  if (!s.yutto?.ok) {
    setHidden('notice', false);
    setText('notice-body', YSLLang.T('engine_down'));
    setText('quota-line', '');
  }
  /* B站 专属（登录卡片）：小红书站服务端已整段剥掉，这里的节点全是 null */
  if (ENGINE === 'bili') {
    const a = s.auth || {};
    if ($('auth-dot')) $('auth-dot').className = 'dot ' + (a.logged_in ? 'on' : 'off');
    setText('auth-text', a.logged_in ? YSLLang.T('done') : YSLLang.T('quality'));
    // 注意：公开模式下面会把 #auth-desc 整段 innerHTML 换掉，那个 <code id="auth-path"> 会消失，
    // 所以这里必须判空（否则第二次刷新状态就抛 "Cannot set properties of null"）
    const ap = $('auth-path');
    if (ap) ap.textContent = s.public ? YSLLang.T('auth_path_server') : '%APPDATA%\\yutto\\auth.toml';
  }
  $('dir-input').value = s.download_dir || '';

  /* 公开模式：提示条 + 额度 + 管理解锁 */
  IS_PUBLIC = !!s.public;
  IS_ADMIN = !!s.is_admin;
  ENGINE = s.engine || ENGINE;
  if (IS_PUBLIC) {
    const hours = s.retention_hours || 1;
    const rt = YSLLang.current === "zh"
      ? (hours === 1 ? "1 小时" : hours + " 小时")
      : (hours === 1 ? "1 hour" : hours + " hours");
    $('notice').hidden = false;
    $('foot-mode').textContent = YSLLang.T('footer_use', { rt: rt });
    // 保留时长换算成秒，供文件列表的"还剩多久"倒计时使用
    if (s.retention_hours) RETENTION_SEC = Math.round(s.retention_hours * 3600);
    /* 三引擎各自的使用须知。别用二选一的三元表达式：新引擎会落到别人家的文案上
       （2026-10-17 用户在 /music/ 的须知里看到了 B站）。这段还是 JS 运行时渲染的，
       curl 首屏自检抓不到 —— 必须断言渲染后的 #notice-body。 */

    $('notice-body').textContent = YSLLang.T('notice', { rt: rt });
    const q = s.quota || {};
    setText('quota-line', YSLLang.T('quota', {
      left: Math.max(0, (q.per_ip_limit || 0) - (q.per_ip_used || 0)),
      gleft: Math.max(0, (q.global_limit || 0) - (q.global_used || 0)) }));
    setHidden('dirrow', true);                  // 服务器模式下不显示"保存路径"框（路径由服务器决定，显示只会误导）
    setHidden('btn-save-dir', true);
    setHidden('btn-open', true);
    /* 以下是 B站 专属：扫码登录 + 用后即毁凭据。小红书免登录，服务端已把这些节点剥掉 */
    if (ENGINE === 'bili') {
      setHidden('admin-pass', true);
      setHidden('btn-unlock', true);
      setHidden('btn-login', false);            // 人人可用自己的账号登录
      const cb = $('chk-batch');
      if (cb && cb.closest('label')) cb.closest('label').style.display = 'none';
      const s4 = s.session || {};
      setHidden('sess-line', false);
      setText('sess-line', s4.has_bili_auth
        ? YSLLang.T('sess_in', { ttl: s4.ttl_minutes }) : YSLLang.T('sess_out'));
      setHidden('btn-forget', !s4.has_bili_auth);
      if ($('auth-desc')) {
        $('auth-desc').textContent = YSLLang.T('login_desc');
      }
    }
  } else {
    setHidden('dirrow', false);
    setHidden('btn-save-dir', false);
  }
  // 放在最后：引擎相关的显隐是最终裁决（避免被上面的公开模式开关覆盖）
  applyEngineLayout(s);
  if (window.YSLLang) YSLLang.apply();   // 布局定完再刷一遍文案
}

/* 双引擎布局：小红书隐藏 B站 专属控件，显示小红书专属控件 */
function applyEngineLayout(s) {
  const xhs = (ENGINE === 'xhs');
  const music = (ENGINE === 'music');
  /* 三引擎文案兜底表：服务端已注入过一遍（<!--URL-PH-->/<!--H1-->/<!--BRAND-->），
     这里保持同值，避免"先闪对方文案"的老问题以另一种形式回来 */

  const show = (id, on) => { const el = $(id); if (el) el.hidden = !on; };
  show('music-login-card', music);
  show('btn-music-list', music);
  show('opt-music-level', music);
  /* 小红书：分享链接提示 + 专属选项；不看登录卡片 */
  show('xhs-tip', xhs);
  show('xhs-what', xhs);
  show('opt-mode', !xhs);
  show('opt-quality', !xhs);
  show('opt-audio', false);
  show('bili-checks', !xhs);
  show('opt-imagefmt', xhs);
  show('opt-notefmt', xhs);
  show('opt-index', xhs);
  show('opt-videopref', xhs);
  show('xhs-checks', xhs);
  show('login-card', !xhs);
  const u = $('url');
  if (u) {
    /* 服务端已按引擎填好提示语（<!--URL-PH-->）；这里只是兜底，文案必须与服务端 PAGE_TEXT 一致，
       否则「先闪一下对方文案」的老问题会以另一种形式回来 */
    /* 文案一律交给 i18n.js（data-i18n / data-i18n-ph），这里不再覆盖 */
  }
  const h1 = document.querySelector('h1');
  const brand = document.querySelector('.brand-text strong');
  document.title = YSLLang.T("title");   // 标题交给 i18n
}

/* ---------- 文件列表 ---------- */
async function loadFiles() {
  const d = await api('api/files');
  const ul = $('files');
  ul.innerHTML = '';
  if (!d.files.length) {
    ul.innerHTML = ('<li class="empty">' + YSLLang.T('files_empty') + '</li>');
    return;
  }
  for (const f of d.files) {
    const li = document.createElement('li');
    const name = document.createElement('div');
    name.className = 'fname';
    name.textContent = f.label || f.name;        // 只显示文件名（不显示 Download/ 这类中间目录）
    const meta = document.createElement('div');
    meta.className = 'fmeta';
    meta.textContent = `${fmtBytes(f.size)} · ${fmtDate(f.mtime)}`;
    // 剩余保留时间：文件 1 小时后会被自动清理，让老师一眼看到还剩多久（<10 分钟标红）
    const exp = document.createElement('div');
    // 注意单位：RETENTION_SEC 是「秒」，f.mtime 是「秒级时间戳」→ 先算剩余秒，再换成分
    const leftMin = (f) => Math.max(0, Math.round((RETENTION_SEC - (Date.now() / 1000 - f.mtime)) / 60));
    const left = leftMin(f);
    const soon = left <= 10;
    exp.className = 'fexp' + (soon ? ' warn' : '');
    exp.textContent = left <= 0 ? YSLLang.T('expiring') : YSLLang.T('keep_min', { n: left });
    exp.dataset.role = 'exp';
    exp.title = YSLLang.T('exp_tip');
    const btns = document.createElement('div');
    btns.className = 'fbtns';
    li.dataset.mtime = f.mtime;   // 供每分钟的倒计时刷新使用

    const isAudioFile = ['mp3', 'm4a', 'flac', 'wav', 'aac', 'ogg', 'opus'].includes((f.ext || '').toLowerCase());
    if (isAudioFile || ['mp4', 'mkv', 'mov', 'webm'].includes(f.ext)) {
      const b = document.createElement('button');
      b.className = 'btn ghost';
      b.textContent = YSLLang.T(isAudioFile ? 'listen' : 'play');
      b.onclick = () => openPlayer(f);
      btns.appendChild(b);
    }
    const dl = document.createElement('a');
    dl.className = 'btn ghost'; dl.textContent = YSLLang.T('save_as');
    // 相对路径逐段编码、保留 "/"：这样 Download/xxx.jpg 这种嵌套路径也能正确取回
    dl.href = 'dl/' + String(f.name).split('/').map(encodeURIComponent).join('/');
    btns.appendChild(dl);

    li.append(name, meta, exp, btns);
    ul.appendChild(li);
  }
}

/* ---------- 播放器 ---------- */
function openPlayer(f) {
  const AUDIO = ['mp3', 'm4a', 'flac', 'wav', 'aac', 'ogg', 'opus'];
  const isAudio = AUDIO.includes((f.ext || '').toLowerCase());
  $('player-name').textContent = f.label || f.name;
  const v = $('player-video'), a = $('player-audio');
  const src = 'files/' + String(f.name).split('/').map(encodeURIComponent).join('/');
  if (isAudio) {
    if (v) { v.pause(); v.removeAttribute('src'); v.load(); }
    setHidden('player', true);
    pbarShow(f);            // 音频：贴底细条，不占地方
  } else {
    pbarHide();
    setHidden('player-video', false);
    v.src = src;
    $('player').hidden = false;
    v.play().catch(() => {});
  }
}

bind('btn-close-player', () => {
  ['player-video', 'player-audio'].forEach((id) => {
    const el = $(id);
    if (el) { try { el.pause(); } catch (e) {} el.removeAttribute('src'); el.load(); }
  });
  setHidden('player', true);
});


/* ---------- 下载 ---------- */
function readOpts() {
  if (ENGINE === 'music') {
    return {
      // cookie 只来自「扫码登录」（服务端写 .ne_cookie），页面上不再有手工输入框
      level: $('music-level') ? $('music-level').value : 'standard',
    };
  }
  if (ENGINE === 'xhs') {
    return {
      image_format: $('image-format') ? $('image-format').value : 'auto',
      note_format: $('note-format') ? $('note-format').value : '',
      index: $('index') ? $('index').value : '',
      video_pref: $('video-pref') ? $('video-pref').value : 'resolution',
      live: $('chk-live') ? $('chk-live').checked : false,
      cover: $('chk-vcover') ? $('chk-vcover').checked : false,
      folder_mode: $('chk-folder') ? $('chk-folder').checked : false,
      write_mtime: $('chk-mtime') ? $('chk-mtime').checked : false,
    };
  }
  return {
    mode,
    quality: $('quality').value,
    audio_out: $('audio-fmt').value,
    danmaku: $('chk-danmaku').checked,
    subtitle: $('chk-subtitle').checked,
    cover: $('chk-cover').checked,
    batch: $('chk-batch').checked,
    overwrite: $('chk-overwrite').checked,
  };
}

/* 视频/音频切换：B站 专属控件（xhs 站服务端已剥掉 → on() 会自动跳过） */
on('mode', 'click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  mode = b.dataset.v;
  [...$('mode').children].forEach((x) => x.classList.toggle('on', x === b));
  const audio = (mode === 'audio');
  setHidden('opt-quality', audio);
  setHidden('opt-audio', !audio);
  const sub = $('chk-subtitle'), dm = $('chk-danmaku');
  if (sub) sub.closest('label').style.display = audio ? 'none' : '';
  if (dm) dm.closest('label').style.display = audio ? 'none' : '';
});

$('btn-paste').onclick = async () => {
  try {
    const t = await navigator.clipboard.readText();
    if (t) $('url').value = t.trim();
  } catch { $('url').focus(); toast(YSLLang.T('clip_fail')); }
};

$('btn-start').onclick = async () => {
  const url = $('url').value.trim();
  if (!url) { $('url').focus(); return; }
  /* 音乐站：输入的不是链接（= 歌名）时，先列出前 5 条让老师挑；
     不再替他盲选第一条（可能下到翻唱/错版本，还白扣一次额度）。 */
  if (ENGINE === 'music' && !/^https?:\/\//i.test(url)) {
    $('btn-start').disabled = true;
    setHidden('music-tracks', false);
    const box = $('music-tracks');
    if (box) box.innerHTML = '<p class="sub">' + YSLLang.T('tracks_loading') + '</p>';
    const r0 = await api('api/music/list?url=' + encodeURIComponent(url));
    $('btn-start').disabled = false;
    if (r0.error) {
      if (box) box.innerHTML = '<p class="sub">' + YSLLang.T('tracks_fail') + r0.error + '</p>';
      return;
    }
    renderTracks(r0);
    return;
  }
  $('btn-start').disabled = true;
  const r = await api('api/job', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, ...readOpts() }),
  });
  if (r.error) { toast(r.error); $('btn-start').disabled = false; return; }
  loadStatus();                                   // 刷新额度显示
  watch(r.id);
};

$('btn-cancel').onclick = async () => {
  if (curJob) await api('api/cancel/' + curJob, { method: 'POST' });
};
$('btn-open').onclick = () => api('api/open-folder', { method: 'POST' });
$('btn-refresh').onclick = loadFiles;
$('btn-save-dir').onclick = async () => {
  const r = await api('api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ download_dir: $('dir-input').value.trim() }),
  });
  $('dir-input').value = r.download_dir;
  loadFiles();
};

/* ---------- 任务轮询 ---------- */
function watch(id) {
  curJob = id;
  $('job-card').hidden = false;
  $('btn-cancel').hidden = false;
  $('log').textContent = '';
  $('meta-thumb').hidden = true;
  $('meta-title').textContent = YSLLang.T('parsing');
  $('meta-sub').textContent = '';
  $('bar-fill').style.width = '0%';
  $('bar-fill').classList.add('indet');
  clearInterval(timer);
  timer = setInterval(() => poll(id), 700);
  poll(id);
}

async function poll(id) {
  const j = await api('api/job/' + id);
  if (j.error) { clearInterval(timer); return; }
  render(j);
  if (['done', 'failed', 'canceled'].includes(j.state)) {
    clearInterval(timer);
    $('btn-start').disabled = false;
    $('btn-cancel').hidden = true;
    loadFiles();
    if (j.state === 'done') {
      loadStatus();
      // 完成后把老师带到文件列表，并把「另存为」闪一下（1 小时后文件会被删）
      setTimeout(() => {
        const card = $('files-card');
        if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        const a = document.querySelector('#files li a.btn');
        if (a) { a.classList.add('hl'); setTimeout(() => a.classList.remove('hl'), 5000); }
      }, 600);
    }
    /* 歌单行点「试听」：这个任务一完成就自动播最新那个音频文件 */
    if (j.state === 'done' && PENDING_PREVIEW === id) {
      PENDING_PREVIEW = null;
      api('api/files').then((d) => {
        const f = (d.files || []).slice().sort((a, b) => b.mtime - a.mtime)[0];
        if (f && f.ext !== 'mp4' && f.ext !== 'mkv') pbarShow(f);
      });
    }
  }
}

function render(j) {
  /* 元信息 */
  const m = j.meta || {};
  if (m.title) {
    $('meta-title').textContent = m.title;
    const bits = [];
    if (m.uploader) bits.push(YSLLang.T('up') + m.uploader);
    if (m.duration) bits.push(YSLLang.T('dur') + fmtTime(m.duration));
    if (j.expected) bits.push(YSLLang.T('est') + fmtBytes(j.expected));
    $('meta-sub').textContent = bits.join(' · ');
    if (m.thumbnail) { $('meta-thumb').src = m.thumbnail; $('meta-thumb').hidden = false; }
  }
  /* 进度 */
  const fill = $('bar-fill');
  if (j.percent != null && j.state !== 'queued') {
    fill.classList.remove('indet');
    fill.style.width = Math.min(100, j.percent) + '%';
  } else if (['running', 'queued'].includes(j.state)) {
    fill.classList.add('indet');
    fill.style.width = '35%';
  }
  /* 状态行 */
  const ph = $('phase');
  const PHASE_KEY = { '准备中': 'ready', '下载中': 'working', '完成': 'done', '失败': 'failed',
    '已取消': 'canceled', '等待扫码': 'waiting_scan', '登录成功 ✓': 'login_done',
    '登录未完成': 'login_fail' };
  ph.textContent = PHASE_KEY[j.phase] ? YSLLang.T(PHASE_KEY[j.phase])
    : (j.phase || YSLLang.T(j.state));
  ph.className = 'phase' + (j.state === 'failed' ? ' fail' : '');
  const parts = [];
  if (j.written) parts.push(YSLLang.T('written', { v: fmtBytes(j.written) }));
  if (j.percent != null) parts.push(j.percent + '%');
  parts.push(YSLLang.T('elapsed', { v: j.elapsed }));
  if (j.error) parts.push(YSLLang.T('err_prefix') + j.error);
  $('stat').textContent = parts.join(' · ');
  if (j.new_files && j.new_files.length) {
    $('stat').textContent += ' · ' + YSLLang.T('new_files') + j.new_files.join(YSLLang.T('file_sep'));
  }
  /* 日志 */
  const logEl = $('log');
  const atBottom = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 24;
  logEl.textContent = (j.log || []).join('\n');
  if (atBottom) logEl.scrollTop = logEl.scrollHeight;
  /* 登录二维码（yutto 用 ▀▄█ 块字符画码，直接贴到 <pre> 就能扫） */
  if (j.kind === 'login') {
    const qr = pickQr(j.log || []);
    if (qr) {
      $('qr-panel').hidden = false;
      $('qr-pre').textContent = qr;
    }
    $('qr-state').textContent = j.state === 'done' ? YSLLang.T('login_done')
      : j.state === 'failed' ? (YSLLang.T('login_fail') + ': ' + (j.error || '')) : YSLLang.T('qr_wait');
  }
}

function pickQr(lines) {
  const blockChars = /[█▀▄░▒▓ ]/;
  const good = (l) => l.length > 20 && [...l].filter((c) => blockChars.test(c)).length / l.length > 0.55;
  const rows = lines.filter(good);
  return rows.length >= 8 ? rows.join('\n') : null;
}

/* ---------- 登录 ---------- */
bind('btn-login', async () => {              // B站 专属；小红书站没有这个节点
  const r = await api('api/login', { method: 'POST' });
  if (r.error) { toast(r.error); return; }
  $('qr-panel').hidden = false;
  $('qr-pre').textContent = YSLLang.T('qr_gen');
  $('qr-state').textContent = YSLLang.T('qr_wait');
  $('btn-login').disabled = true;
  let t = setInterval(async () => {
    const j = await api('api/job/' + r.id);
    render(Object.assign({}, j, { kind: 'login' }));
    if (['done', 'failed', 'canceled'].includes(j.state)) {
      clearInterval(t);
      $('btn-login').disabled = false;
      loadStatus();
    }
  }, 1200);
});

bind('btn-forget', async () => {             // B站 专属
  if (!confirm(YSLLang.T('confirm_forget'))) return;
  const r = await api('api/session/destroy', { method: 'POST' });
  setHidden('qr-panel', true);
  await loadStatus();
  if (r.destroyed) setText('sess-line', YSLLang.T('destroyed'));
  loadFiles();
});

/* ---------- 音乐：扫码登录 ---------- */
async function refreshNeAuth() {
  if (ENGINE !== 'music') return;
  try {
    const r = await api('api/ne-auth');
    const on = !!r.logged_in;
    const dot = $('ne-auth-dot');
    if (dot) dot.className = 'dot ' + (on ? 'on' : 'off');
    const t = $('ne-auth-text');
    if (t) t.textContent = YSLLang.T(on ? 'auth_in' : 'auth_out');
    const f = $('btn-ne-forget');
    if (f) f.hidden = !on;
  } catch (e) { /* 忽略：登录态只是锦上添花 */ }
}

bind('btn-ne-login', async () => {
  const r = await api('api/login', { method: 'POST' });
  if (r.error) { toast(r.error); return; }
  setHidden('ne-qr-panel', false);
  setText('ne-qr-state', YSLLang.T('qr_wait'));
  const img = $('ne-qr-img');
  let t = setInterval(async () => {
    const j = await api('api/job/' + r.id);
    /* 二维码从任务日志里取（B站 扫码就是这套 pickQr），不依赖按会话取文件 */
    const qr = pickQr(j.log || []);
    if (qr) setText('ne-qr-pre', qr);
    setText('ne-qr-state', j.state === 'done' ? YSLLang.T('login_done')
      : j.state === 'failed' ? (YSLLang.T('login_fail') + ': ' + (j.error || '')) : YSLLang.T('qr_hint'));
    if (['done', 'failed', 'canceled'].includes(j.state)) {
      clearInterval(t);
      refreshNeAuth();
      loadStatus();
    }
  }, 1500);
});

bind('btn-ne-forget', async () => {
  if (!confirm(YSLLang.T('confirm_forget'))) return;
  await api('api/session/destroy', { method: 'POST' });
  setHidden('ne-qr-panel', true);
  refreshNeAuth();
  loadFiles();
});

/* ---------- 音乐：歌单曲目列表（方案 A：只列曲目，逐首取） ---------- */
function fmtDur(ms) {
  const s = Math.round((ms || 0) / 1000);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

function renderTracks(d) {
  const box = $('music-tracks');
  if (!box) return;
  box.innerHTML = '';
  const head = document.createElement('p');
  head.className = 'sub';
  const KIND = { playlist: '歌单', album: '专辑', dj: '电台节目' };
  phead = (YSLLang.current === 'zh'
    ? { playlist: '歌单', album: '专辑', dj: '电台节目' }[d.kind] || '曲目'
    : { playlist: 'Playlist', album: 'Album', dj: 'Radio episode' }[d.kind] || 'Tracks');
  head.textContent = phead + (d.title ? ' “' + d.title + '”' : '') + ' · ' + d.count
    + YSLLang.T('tracks_note');
  const ul = document.createElement('ul');
  ul.className = 'files';
  for (const t of d.tracks) {
    const li = document.createElement('li');
    const name = document.createElement('div');
    name.className = 'fname';
    name.textContent = (t.artist ? t.artist + ' - ' : '') + t.name;
    const meta = document.createElement('div');
    meta.className = 'fmeta';
    meta.textContent = fmtDur(t.dur) + (t.fee === 1 ? YSLLang.T('fee_vip') : '');
    const btns = document.createElement('div');
    btns.className = 'fbtns';
    const submit = async (preview) => {
      const r = await api('api/job', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign(
          { url: 'https://music.163.com/song?id=' + t.id }, readOpts(), { preview: !!preview })),
      });
      if (r.error) { toast(r.error); return; }
      if (preview) PENDING_PREVIEW = r.id;   // 取回后自动在底部播放条里播
      loadStatus();
      watch(r.id);
    };
    const bp = document.createElement('button');
    bp.className = 'btn ghost';
    bp.textContent = YSLLang.T('listen');
    bp.title = YSLLang.T('listen_tip');
    bp.onclick = () => {
      ul.querySelectorAll('li').forEach((x) => x.classList.remove('playing'));
      li.classList.add('playing');
      submit(true);
    };
    const b = document.createElement('button');
    b.className = 'btn ghost';
    b.textContent = YSLLang.T('get_one');
    b.onclick = () => submit(false);
    btns.append(bp, b);
    li.append(name, meta, btns);
    ul.appendChild(li);
  }
  /* 100 首歌单得能筛：输入关键词即时过滤（前端过滤，零请求） */
  const filt = document.createElement('input');
  filt.id = 'tracks-filter';
  filt.type = 'search';
  filt.placeholder = YSLLang.T('filter_ph');
  filt.addEventListener('input', () => {
    const q = filt.value.trim().toLowerCase();
    ul.querySelectorAll('li').forEach((li) => {
      li.style.display = (!q || li.textContent.toLowerCase().includes(q)) ? '' : 'none';
    });
  });
  box.append(head, filt, ul);
}

bind('btn-music-list', async () => {
  const u = $('url').value.trim();
  if (!u) { $('url').focus(); return; }
  setHidden('music-tracks', false);
  const box = $('music-tracks');
  if (box) box.innerHTML = '<p class="sub">' + YSLLang.T('tracks_loading') + '</p>';
  const r = await api('api/music/list?url=' + encodeURIComponent(u));
  if (r.error) {
    if (box) box.innerHTML = '<p class="sub">' + YSLLang.T('tracks_fail') + r.error + '</p>';
    return;
  }
  renderTracks(r);
});

/* 歌单行点「试听」：等这个任务完成后自动播放（见 poll()） */
let PENDING_PREVIEW = null;

/* ---------- 贴底细播放条（音频） ---------- */
let PBAR = null;

function fmtSec(s) {
  s = Math.max(0, Math.round(s || 0));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

function pbarShow(f) {
  const a = $('player-audio');
  if (!a) return;
  PBAR = f;
  // 文件列表里把正在播的那一行标出来
  document.querySelectorAll('#files li').forEach((li) => {
    const n = li.querySelector('.fname');
    li.classList.toggle('playing', !!(n && (n.textContent === (f.label || f.name))));
  });
  setText('pbar-title', f.label || f.name);
  setText('pbar-sub', fmtBytes(f.size) + (f.ext ? ' · ' + String(f.ext).toUpperCase() : ''));
  setHidden('pbar', false);
  document.body.classList.add('has-pbar');
  a.src = 'files/' + String(f.name).split('/').map(encodeURIComponent).join('/');
  a.play().catch(() => {});
  pbarSync();
}

function pbarHide() {
  document.querySelectorAll('#files li.playing').forEach((li) => li.classList.remove('playing'));
  const a = $('player-audio');
  if (a) { try { a.pause(); } catch (e) {} a.removeAttribute('src'); a.load(); }
  setHidden('pbar', true);
  document.body.classList.remove('has-pbar');
}

function pbarSync() {
  const a = $('player-audio');
  if (!a) return;
  const t = $('pbar-toggle');
  if (t) t.textContent = a.paused ? '▶' : '❚❚';
  setText('pbar-time', fmtSec(a.currentTime) + ' / ' + fmtSec(a.duration));
  const sk = $('pbar-seek');
  if (sk && a.duration) sk.value = String(Math.round(a.currentTime / a.duration * 1000));
}

on('player-audio', 'timeupdate', pbarSync);
on('player-audio', 'loadedmetadata', pbarSync);
on('player-audio', 'ended', pbarSync);
bind('pbar-toggle', () => {
  const a = $('player-audio');
  if (!a) return;
  if (a.paused) a.play().catch(() => {}); else a.pause();
  pbarSync();
});
on('pbar-seek', 'input', () => {
  const a = $('player-audio'), sk = $('pbar-seek');
  if (a && a.duration && sk) a.currentTime = a.duration * (sk.value / 1000);
});
on('pbar-vol', 'input', () => {
  const a = $('player-audio'), v = $('pbar-vol');
  if (a && v) a.volume = Math.min(1, v.value / 100);
});
bind('pbar-close', pbarHide);

/* 语言切换后重渲染（须知/额度/会话行在 loadStatus 里生成，文件列表在 loadFiles 里生成） */
window.addEventListener("ysl-lang", () => { try { loadStatus(); loadFiles(); } catch (e) {} });

/* ---------- 启动 ---------- */
/* AUTO FOCUS：输入框是用户进站第一个要找的地方。桌面端且为空时自动聚焦，
   手机上不抢焦点（否则会弹软键盘挡住页面）；同时给一次性柔光把视线引过去。 */
try {
  const u0 = $('url');
  if (u0 && !u0.value) {
    u0.classList.add('attract');
    setTimeout(() => u0.classList.remove('attract'), 3600);
    if (window.innerWidth >= 900) setTimeout(() => u0.focus(), 250);
  }
} catch (e) {}
loadStatus().then(() => refreshNeAuth());
loadFiles();
$('url').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-start').click(); });
setInterval(() => { if (!curJob) loadFiles(); }, 15000);
// 倒计时每分钟刷新一次（不重新请求接口，只按时间重算文字）
setInterval(() => {
  document.querySelectorAll('#files li').forEach((li) => {
    const el = li.querySelector('.fexp');
    const m = li.dataset.mtime;
    if (!el || !m) return;
    // 同样按「秒」算剩余，再换成分（之前这里也把秒当分用了）
    const left = Math.max(0, Math.round((RETENTION_SEC - (Date.now() / 1000 - Number(m))) / 60));
    el.textContent = left <= 0 ? YSLLang.T('expiring') : YSLLang.T('keep_min', { n: left });
    el.classList.toggle('warn', left <= 10);
  });
}, 60000);
