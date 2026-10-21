#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
云树灵 · B站下载器（网页版 yutto）

本地运行的网页界面：粘贴 B 站链接 -> 解析 -> 下载（视频 / 只要音频 MP3），
全程在本机执行，不上传任何东西。

后端只用 Python 标准库；下载引擎 = yutto（需 pip install yutto），
预取信息 = 同环境的 yt-dlp。

启动： python app.py   （或双击 start.cmd）
"""
from __future__ import annotations

import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import ipaddress
from pathlib import Path
from urllib.parse import quote, unquote, urlparse

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
CONFIG_PATH = ROOT / "config.json"

# ---- 公开部署（服务器版）相关开关，全部用环境变量控制，本地跑不受影响 ----
PUBLIC_MODE = os.environ.get("YSL_PUBLIC") == "1"          # 服务器公开模式：限额/清理/防索引/免责声明
TRUST_PROXY = os.environ.get("YSL_TRUST_PROXY") == "1"     # 相信 X-Forwarded-For（nginx 反代后面）
ADMIN_PASSWORD = os.environ.get("YSL_ADMIN_PASSWORD", "")  # 管理口令（登录/改目录等敏感操作）
# 引擎切换：bili = B站（yutto）｜ xhs = 小红书（XHS-Downloader，独立进程调用）
ENGINE = os.environ.get("YSL_ENGINE", "bili").lower()
XHS_REPO = os.environ.get("YSL_XHS_REPO", "/opt/xhs-dl")
XHS_PY = os.environ.get("YSL_XHS_PY", "/opt/xhs-dl/.venv/bin/python")
# 音乐引擎：pyncm（纯 Python 网易云 API，weapi 加密自算，不需要浏览器/Node 服务）
NE_REPO = os.environ.get("YSL_NE_REPO", "/opt/ysl-music-web")
NE_PY = os.environ.get("YSL_NE_PY", "/opt/ne/.venv/bin/python")
IGNORE_EXTS = {".db", ".db-journal", ".db-wal", ".db-shm", ".tmp", ".part", ".json"}
# 部署在子路径时（如门户站下的 /bili/）由 nginx 剥掉前缀，这里只需要把 <base> 写对，
# 让页面里的相对 URL（api/...、static/...、dl/...）都落在自己的前缀下
BASE_PATH = (os.environ.get("YSL_BASE_PATH", "") or "").rstrip("/")

# 页面文案按引擎（以及公开/本地模式）由**服务端注入** —— 避免"小红书页面上写着 B站下载器"这类错位，
# 也避免 JS 执行前先闪一下错误的标题。
PAGE_TEXT = {
    "bili": {
        "title": "B站下载器 · 云树灵",
        "brand": "B站下载器",
        "icon": "static/icons/bili.png",          # B站 官方应用图标（App Store 来源，已去掉赛季角标）
        "h1": "粘链接，选格式，下载",
        "url_ph": "https://www.bilibili.com/video/BV…  或直接粘 BV 号",
        "sub_public": "支持视频链接、BV 号、番剧 ep 号。由云树灵服务器代下，文件按会话隔离存放，1 小时后自动删除。",
        "sub_local": "支持视频链接、BV 号、番剧 ep 号。文件下载到本机指定目录。",
    },
    "xhs": {
        "title": "小红书下载器 · 云树灵",
        "brand": "小红书下载器",
        "icon": "static/icons/xhs.png",           # 小红书 官网图标，直接套用
        "h1": "粘分享链接，取原图与原视频",
        "url_ph": "粘小红书分享链接：xhslink.com/…  或  www.xiaohongshu.com/…",
        "sub_public": "在小红书里点「分享 → 复制链接」，把链接粘到这里即可取回原图 / 原视频（无水印）。不需要登录；文件按会话隔离存放，1 小时后自动删除。",
        "sub_local": "在小红书里点「分享 → 复制链接」，粘到这里取回原图 / 原视频（无水印）。不需要登录。",
    },
    "music": {
        "title": "音乐下载器 · 云树灵",
        "brand": "音乐下载器",
        "icon": "static/icons/ne.png",
        "h1": "粘歌曲链接或歌名，取 MP3",
        "url_ph": "粘网易云歌曲链接，或直接输入歌名，例如：菊花台",
        "sub_public": "由云树灵服务器代取音频并转成 MP3（原本是 MP3 的直接保存，不重编码）。不登录可取标准音质；点上方「扫码登录」用自己的网易云账号，可解锁更高音质与个人歌单。文件按会话隔离存放，1 小时后自动删除。",
        "sub_local": "粘歌曲链接或歌名，下载到本机目录。",
    },
}
PER_IP_DAILY = int(os.environ.get("YSL_PER_IP_DAILY", "15"))
GLOBAL_DAILY = int(os.environ.get("YSL_GLOBAL_DAILY", "200"))
# 文件保留时长：优先用 YSL_RETENTION_HOURS（支持小数，如 0.5 = 30 分钟），
# 没给才回落到旧的 YSL_RETENTION_DAYS（天），保证老配置不炸
if os.environ.get("YSL_RETENTION_HOURS") is not None:
    RETENTION_HOURS = float(os.environ["YSL_RETENTION_HOURS"])
else:
    RETENTION_HOURS = float(os.environ.get("YSL_RETENTION_DAYS", "3")) * 24.0
RETENTION_SECONDS = max(60, int(RETENTION_HOURS * 3600))
QUOTA_PATH = Path(os.environ.get("YSL_QUOTA_PATH", str(ROOT / "quota.json")))
# ---- 会话隔离的 B站 凭据（公开模式下：一人一份、用完即毁）----
SESSION_TTL = int(os.environ.get("YSL_SESSION_TTL", "1800"))      # 闲置多久销毁（秒）
SESSIONS_DIR = Path(os.environ.get("YSL_SESSIONS_DIR",
                                   "/srv/bili/sessions" if os.name != "nt" else str(ROOT / "sessions")))

if os.name == "nt":
    DEFAULT_DOWNLOAD_DIR = Path(r"D:\YIN-PROJE\downloads\bilibili")
else:
    DEFAULT_DOWNLOAD_DIR = Path("/srv/bili/downloads")
# 允许用环境变量指定下载根目录（门户里多个子应用各自一个根，互不打扰）
if os.environ.get("YSL_DOWNLOAD_DIR"):
    DEFAULT_DOWNLOAD_DIR = Path(os.environ["YSL_DOWNLOAD_DIR"])
LISTEN_HOST = "127.0.0.1"
LISTEN_PORT = int(os.environ.get("YSL_PORT", "8765"))

# 子进程统一用 UTF-8，否则 Windows 下中文/二维码会炸（踩坑记录：yutto 的二维码是 ▀▄█ 块字符）
CHILD_ENV = dict(os.environ)
CHILD_ENV.update({"PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1", "PYTHONUNBUFFERED": "1"})

QUALITY_LABEL = {
    "best": "最高可用",
    "127": "8K",
    "120": "4K",
    "116": "1080P60",
    "80": "1080P",
    "64": "720P",
    "32": "480P",
}


# ----------------------------------------------------------------------------- 配置
def load_config() -> dict:
    cfg = {"download_dir": str(DEFAULT_DOWNLOAD_DIR),
           "defaults": {"mode": "video", "quality": "best",
                        "danmaku": False, "subtitle": True, "cover": False, "batch": False}}
    if CONFIG_PATH.exists():
        try:
            cfg.update(json.loads(CONFIG_PATH.read_text(encoding="utf-8")))
        except Exception:
            pass
    return cfg


def save_config(cfg: dict) -> None:
    CONFIG_PATH.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")


CFG_LOCK = threading.Lock()
CFG = load_config()


def download_dir() -> Path:
    # 部署级配置（环境变量）优先于用户偏好（config.json）：
    # 门户里多个子应用各自一个根目录，绝不能被别的实例留下的 config.json 带跑偏
    if os.environ.get("YSL_DOWNLOAD_DIR"):
        d = Path(os.environ["YSL_DOWNLOAD_DIR"])
        d.mkdir(parents=True, exist_ok=True)
        return d
    with CFG_LOCK:
        d = Path(CFG.get("download_dir") or DEFAULT_DOWNLOAD_DIR)
    d.mkdir(parents=True, exist_ok=True)
    return d


def files_dir(sid: str = "") -> Path:
    """下载文件的落点。

    公开模式：按会话建子目录（`<下载根>/<sid>/`）—— 不同的老师互相看不到对方的文件，
    和 B站 凭据同一个隔离粒度。本地模式仍是根目录（只有一个用户，别把路径搞复杂）。
    """
    root = download_dir()
    if not (PUBLIC_MODE and sid):
        return root
    d = root / sid
    try:
        d.mkdir(parents=True, exist_ok=True)
        os.chmod(d, 0o700)
    except OSError:
        pass
    return d


# ----------------------------------------------------------------------------- 小组件
QUOTA_LOCK = threading.Lock()


def fmt_retention() -> str:
    """人话描述保留时长：1 小时 / 30 分钟 / 3 天。"""
    if RETENTION_HOURS < 1:
        return f"{int(round(RETENTION_HOURS * 60))} 分钟"
    if RETENTION_HOURS % 24 == 0 and RETENTION_HOURS >= 24:
        return f"{int(RETENTION_HOURS // 24)} 天"
    return f"{RETENTION_HOURS:g} 小时"


def load_quota() -> dict:
    try:
        return json.loads(QUOTA_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_quota(q: dict) -> None:
    try:
        QUOTA_PATH.write_text(json.dumps(q, ensure_ascii=False), encoding="utf-8")
    except Exception:
        pass


def quota_state() -> dict:
    today = time.strftime("%Y-%m-%d")
    with QUOTA_LOCK:
        q = load_quota()
    if q.get("date") != today:
        q = {"date": today, "total": 0, "ips": {}}
    return q


def quota_charge(ip: str) -> tuple[bool, str]:
    """扣一次额度；返回 (是否允许, 原因)。"""
    if not PUBLIC_MODE:
        return True, ""
    today = time.strftime("%Y-%m-%d")
    with QUOTA_LOCK:
        q = load_quota()
        if q.get("date") != today:
            q = {"date": today, "total": 0, "ips": {}}
        if q["total"] >= GLOBAL_DAILY:
            return False, f"今天全站下载额度已用完（{GLOBAL_DAILY} 次），明天再来"
        used = q["ips"].get(ip, 0)
        if used >= PER_IP_DAILY:
            return False, f"你今天的额度已用完（{PER_IP_DAILY} 次），明天再来"
        # 字典上限：ip 键已保证是合法 IP（见 client_ip），但仍要防"海量不同 IP 把
        # quota.json 撑爆"（攻击者伪造大量来源时，每次任务都会新增一个键）。
        if ip not in q["ips"] and len(q["ips"]) >= 5000:
            return False, "今日访问者过多，请稍后再试"
        q["total"] += 1
        q["ips"][ip] = used + 1
        save_quota(q)
        return True, ""


def cleanup_old_files() -> int:
    """公开模式下删除超过保留期的文件，防爆盘。"""
    if not PUBLIC_MODE or RETENTION_SECONDS <= 0:
        return 0
    cutoff = time.time() - RETENTION_SECONDS
    removed = 0
    root = download_dir()
    # 递归扫（含按会话分的子目录），过期文件全删；删空后的子目录一并收走
    try:
        targets = [p for p in root.rglob("*") if p.is_file()]
    except OSError:
        targets = []
    for p in targets:
        try:
            if p.stat().st_mtime < cutoff:
                p.unlink()
                removed += 1
        except OSError:
            pass
    # 清理空会话目录
    try:
        for d in root.iterdir():
            if d.is_dir():
                try:
                    if not any(d.iterdir()):
                        d.rmdir()
                except OSError:
                    pass
    except OSError:
        pass
    return removed


def cleanup_loop():
    while True:
        try:
            n = cleanup_old_files()
            if n:
                print(f"[cleanup] 已清理 {n} 个过期文件（>{fmt_retention()}）")
            m = sweep_sessions()
            if m:
                print(f"[cleanup] 已销毁 {m} 个闲置会话的 B站 凭据")
        except Exception:
            pass
        time.sleep(60)


threading.Thread(target=cleanup_loop, daemon=True).start()


# ----------------------------------------------------------------------------- 会话级凭据
SESSION_LOCK = threading.Lock()
SESSION_TOUCH: dict[str, float] = {}


def session_dir(sid: str) -> Path:
    return SESSIONS_DIR / sid


def session_auth_file(sid: str) -> Path:
    return session_dir(sid) / "auth.toml"


def session_has_auth(sid: str) -> bool:
    try:
        f = session_auth_file(sid)
        return f.is_file() and f.stat().st_size > 0
    except OSError:
        return False


def new_session() -> str:
    sid = uuid.uuid4().hex
    d = session_dir(sid)
    try:
        d.mkdir(parents=True, exist_ok=True)
        os.chmod(d, 0o700)
    except OSError:
        pass
    with SESSION_LOCK:
        SESSION_TOUCH[sid] = time.time()
    return sid


def touch_session(sid: str) -> None:
    if sid:
        with SESSION_LOCK:
            SESSION_TOUCH[sid] = time.time()


def destroy_session(sid: str) -> bool:
    """销毁会话凭据 + 该会话的下载文件（服务器不再持有这个人的任何东西）。"""
    if not sid or not re.fullmatch(r"[0-9a-f]{6,64}", sid or ""):
        return False
    with SESSION_LOCK:
        SESSION_TOUCH.pop(sid, None)
    d = session_dir(sid)
    try:
        if d.exists():
            shutil.rmtree(d)          # 故意不用 ignore_errors：删不掉必须暴露，不能谎报已销毁
    except OSError as e:
        print(f"[cleanup] !! 删除会话目录失败 {d}：{e}", flush=True)
        return False
    # 连同他的下载文件一起清掉（文件本就按会话隔离存放）
    if PUBLIC_MODE:
        try:
            fd = download_dir() / sid
            if fd.is_dir():
                shutil.rmtree(fd)
        except OSError as e:
            print(f"[cleanup] !! 删除会话文件目录失败 {sid[:8]}：{e}", flush=True)
    return True


def sweep_sessions() -> int:
    """闲置超时的会话：销毁凭据目录。"""
    if not PUBLIC_MODE:
        return 0
    now = time.time()
    dead = []
    try:
        for d in SESSIONS_DIR.iterdir():
            if not d.is_dir():
                continue
            with SESSION_LOCK:
                last = SESSION_TOUCH.get(d.name)
            try:
                if last is None:
                    last = d.stat().st_mtime
            except OSError:
                last = now
            if now - last > SESSION_TTL:
                dead.append(d.name)
    except OSError:
        return 0
    for sid in dead:
        if not destroy_session(sid):
            dead = [x for x in dead if x != sid]
    return len(dead)


def wipe_all_sessions() -> None:
    """启动时清空：服务重启 = 所有凭据一律销毁。"""
    try:
        if SESSIONS_DIR.exists():
            shutil.rmtree(SESSIONS_DIR, ignore_errors=True)
        SESSIONS_DIR.mkdir(parents=True, exist_ok=True)
        os.chmod(SESSIONS_DIR, 0o700)
        with SESSION_LOCK:
            SESSION_TOUCH.clear()
        print("[startup] 已清空全部会话凭据目录（重启即销毁）")
    except OSError as e:
        print(f"[startup] 清空会话目录失败：{e}")


def run_capture(argv, timeout=60):
    try:
        p = subprocess.run(argv, capture_output=True, text=True, encoding="utf-8",
                           errors="replace", env=CHILD_ENV, timeout=timeout)
        return p.returncode, (p.stdout or "") + (p.stderr or "")
    except FileNotFoundError:
        return 127, f"找不到命令：{argv[0]}"
    except subprocess.TimeoutExpired:
        return 124, "命令超时"


def normalize_url(raw: str) -> list[str]:
    """把老师粘贴的内容整理成标准链接列表。

    B站：接受完整链接 / 裸 BV 号 / av 号 / ep 号（单个）。
    小红书：接受 explore、discovery/item 以及 xhslink 短链；
            老师从 App 复制的往往是"一段带说明文字 + 链接"的文本，所以直接抽链接（可多条）。
    """
    s = (raw or "").strip()
    if not s:
        return []
    if ENGINE == "xhs":
        pat = re.compile(r"(?:https?://)?(?:www\.)?(?:xiaohongshu\.com/(?:explore|discovery/item)/[\da-fA-F]+(?:\?[^\s，。；！？、]*)?|xhslink\.(?:com|cn)/[\w\-/?=&%.]+)")
        hits: list[str] = []
        for u in pat.findall(s):
            u = u.rstrip("，。；！？、")
            if not u.startswith("http"):
                u = "https://" + u.lstrip("/")
            if u not in hits:
                hits.append(u)
        return hits
    s = s.split("?")[0] if s.startswith("http") and "bilibili.com/video" not in s else s
    if s.startswith("http"):
        # 去掉 B站 的推广参数，保留必要参数（?p=、?t= 之类）
        keep = []
        q = urlparse(s).query
        for kv in q.split("&"):
            if kv.startswith(("p=", "t=", "start=")):
                keep.append(kv)
        base = s.split("?")[0]
        return [base + ("?" + "&".join(keep) if keep else "")]
    if re.fullmatch(r"BV[0-9A-Za-z]{10}", s):
        return [f"https://www.bilibili.com/video/{s}"]
    if re.fullmatch(r"av\d+", s, re.I):
        return [f"https://www.bilibili.com/video/{s}"]
    if re.fullmatch(r"ep\d+", s, re.I):
        return [f"https://www.bilibili.com/bangumi/play/{s}"]
    if s.startswith("www.bilibili.com") or s.startswith("b23.tv"):
        return ["https://" + s]
    return []


def dir_total_bytes(d: Path) -> int:
    total = 0
    try:
        for p in d.iterdir():
            if p.is_file():
                try:
                    total += p.stat().st_size
                except OSError:
                    pass
    except OSError:
        pass
    return total


def list_files(d: Path):
    """列出可下载的媒体文件。

    注意：要**递归**扫 —— XHS-Downloader 会把文件写进工作目录下的 `Download/`（或按笔记分的子目录），
    只扫第一层会得到"任务完成但列表为空"的假象。列表里的 `name` 是相对路径（供 /dl/、/files/ 使用），
    `label` 是给老师看的文件名。
    """
    out = []
    try:
        files = [p for p in d.rglob("*") if p.is_file() and p.suffix.lower() not in IGNORE_EXTS]
        for p in sorted(files, key=lambda x: x.stat().st_mtime, reverse=True):
            st = p.stat()
            out.append({"name": p.relative_to(d).as_posix(), "label": p.name,
                        "size": st.st_size, "mtime": int(st.st_mtime),
                        "ext": p.suffix.lower().lstrip(".")})
    except OSError:
        pass
    return out


def estimate_bytes(info: dict, mode: str, quality: str) -> int:
    """用 yt-dlp 的格式清单估算总字节数（进度条分母）。"""
    formats = info.get("formats") or []

    def size_of(f):
        return f.get("filesize") or f.get("filesize_approx") or 0

    if mode == "audio":
        auds = [f for f in formats if f.get("vcodec") == "none" and f.get("acodec") != "none"]
        auds.sort(key=lambda f: (f.get("abr") or 0), reverse=True)
        return size_of(auds[0]) if auds else 0

    want = {"best": 10**9, "80": 1080, "64": 720, "32": 480}.get(quality, 10**9)
    if quality in ("116", "120", "127"):
        want = {"116": 1080, "120": 2160, "127": 4320}[quality]
    vids = [f for f in formats
            if f.get("vcodec") != "none" and (f.get("height") or 0) <= want
            and (f.get("ext") or "") == "mp4"]
    if not vids:
        vids = [f for f in formats if f.get("vcodec") != "none"]
    if not vids:
        return 0
    best_h = max((f.get("height") or 0) for f in vids)
    same = [f for f in vids if (f.get("height") or 0) == best_h]
    # yutto 默认优先 AVC
    same.sort(key=lambda f: (0 if (f.get("vcodec") or "").startswith("avc") else 1, size_of(f)))
    auds = [f for f in formats if f.get("vcodec") == "none" and f.get("acodec") != "none"]
    auds.sort(key=lambda f: (f.get("abr") or 0), reverse=True)
    return size_of(same[0]) + (size_of(auds[0]) if auds else 0)


# ----------------------------------------------------------------------------- 任务
class Job:
    def __init__(self, url: str, opts: dict, sid: str = ""):
        self.id = uuid.uuid4().hex[:12]
        self.urls: list[str] = opts.get("urls") or ([url] if url else [])
        self.url = self.urls[0] if self.urls else url
        self.opts = opts
        self.argv: list[str] = []
        self.sid = sid            # 会话 id：B站 凭据按会话隔离，用完即毁
        self.kind = opts.get("kind", "download")      # download | login
        self.state = "queued"                          # queued|running|done|failed|canceled
        self.phase = "排队中"
        self.lines = deque(maxlen=1500)
        self.proc: subprocess.Popen | None = None
        self.lock = threading.Lock()
        self.t0 = time.time()
        self.elapsed = 0.0
        self.baseline = 0
        self.expected = 0
        self.meta: dict = {}
        self.error: str | None = None
        self.files_before: set[str] = set()
        self.new_files: list[str] = []

    def urls_str(self) -> str:
        """XHS-Downloader 支持一次传多条链接（空格分隔）。"""
        return " ".join(self.urls)

    def log(self, text: str):
        for line in (text or "").replace("\r\n", "\n").replace("\r", "\n").split("\n"):
            if line.strip() or line == "":
                self.lines.append(line)

    def snapshot(self) -> dict:
        d = files_dir(self.sid)
        written = max(0, dir_total_bytes(d) - self.baseline)
        pct = None
        if self.expected > 0:
            pct = min(99, round(written / self.expected * 100, 1))
        if self.state == "done":
            pct = 100.0
        return {
            "id": self.id, "kind": self.kind, "state": self.state, "phase": self.phase,
            "url": self.url, "opts": self.opts, "meta": self.meta,
            "expected": self.expected, "written": written, "percent": pct,
            "elapsed": round(self.elapsed or (time.time() - self.t0), 1),
            "error": self.error, "new_files": self.new_files,
            "log": list(self.lines)[-260:],
        }


JOBS: dict[str, Job] = {}
JOB_ORDER: list[str] = []
QUEUE: deque[str] = deque()
QUEUE_LOCK = threading.Lock()
LOGIN_LOCK = threading.Lock()      # 登录任务不占下载队列（扫码可能要等几分钟，别把全站堵住）


def xhs_argv(job: Job) -> list[str]:
    """小红书：调 XHS-Downloader 的 CLI（GPL-3.0，独立进程调用，不改它的代码）。
    它靠链接里的 xsec_token 匿名取数据 —— 所以必须让老师粘"分享链接"。"""
    o = job.opts
    argv = [XHS_PY, "main.py", "-u", job.urls_str(), "-wp", str(files_dir(job.sid)), "-l", "zh_CN"]
    # 关掉"作品下载记录"：XHS-Downloader 默认把已下载过的作品 ID 记在**引擎目录**下的
    # Volume/ExploreID.db（全局、不是按会话），命中就只打印「存在下载记录，跳过处理」并以
    # 退出码 0 结束 —— 结果就是"另一位老师再要同一条笔记 → 显示完成、文件 0 个"。
    # 本站是多人共用、产物按会话隔离，必须每次都真下。
    argv += ["--download_record", "false"]
    fmt = (o.get("image_format") or "auto").upper()
    argv += ["--image_format", "AUTO" if fmt == "AUTO" else fmt]
    nf = o.get("note_format") or ""
    if nf:
        argv += ["--note_format", nf]
    if o.get("live"):
        argv += ["--live_download", "true"]
    if o.get("cover"):
        argv += ["--video_cover_download", "true"]
    idx = (o.get("index") or "").strip()
    if idx:
        argv += ["--index", idx]
    # 视频优先规则（resolution / bitrate / size）—— 视频笔记按这个挑流
    vp = (o.get("video_pref") or "").strip()
    if vp in ("resolution", "bitrate", "size"):
        argv += ["--video_preference", vp]
    if o.get("folder_mode"):
        argv += ["--folder_mode", "true"]
    if o.get("write_mtime"):
        argv += ["--write_mtime", "true"]
    return argv


def ne_login_argv(job: Job) -> list[str]:
    """网易云扫码登录：ne_login.py 出二维码 → 老师扫 → 写 600 权限的 .ne_cookie。"""
    return [NE_PY, os.path.join(NE_REPO, "ne_login.py"), "-o", str(files_dir(job.sid))]


def music_argv(job: Job) -> list[str]:
    """网易云：调 ne_dl.py（pyncm）。cookie 走 600 权限临时文件，理由见下方注释。"""
    o = job.opts
    argv = [NE_PY, os.path.join(NE_REPO, "ne_dl.py"), "-u", job.urls_str(),
            "-o", str(files_dir(job.sid)), "--level", str(o.get("level") or "standard")]
    if o.get("preview"):
        # 试听只取前 30 秒：省流量，也不用等整首下来
        argv += ["--preview-sec", "30"]
    ck = (o.get("cookie") or "").strip()
    if not ck:
        # 扫过码就直接用会话里的登录态，老师不必再粘任何东西
        sp = files_dir(job.sid) / ".ne_cookie"
        if sp.is_file():
            argv += ["--cookie-file", str(sp)]
            return argv
    if ck:
        # 任务命令行会被完整写进任务日志展示给用户（job.log("$ " + " ".join(argv))）
        # → cookie 绝不能进 argv，只能落在 600 权限的文件里
        p = files_dir(job.sid) / ".ne_cookie"
        p.write_text(ck, encoding="utf-8")
        try:
            os.chmod(p, 0o600)
        except OSError:
            pass
        argv += ["--cookie-file", str(p)]
    return argv


def yutto_argv(job: Job) -> list[str]:
    o = job.opts
    argv = [sys.executable, "-m", "yutto", job.url]
    # 公开模式：用本会话自己的 B站 凭据（只传文件路径，绝不把 cookie 拼进命令行 → 日志里不会出现凭据）
    # 本地模式：沿用 yutto 默认 profile，方便和终端里的 yutto 共用登录态
    if PUBLIC_MODE and job.sid and session_has_auth(job.sid):
        argv += ["--auth-file", str(session_auth_file(job.sid))]
    if o.get("mode") == "audio":
        # 先拿原始码流（m4a 无损封装）；要 MP3 时由本地 ffmpeg 以高码率转码
        # （yutto 自带的 mp3 输出固定 128k，音质不够）
        want = "m4a" if o.get("audio_out") == "m4a" else "m4a"
        argv += ["--audio-only", "--output-format-audio-only", want]
    q = o.get("quality", "best")
    if q and q != "best":
        argv += ["-q", str(q)]
    argv += ["-df", "ass"] if o.get("danmaku") else ["--no-danmaku"]
    argv += [] if o.get("subtitle") else ["--no-subtitle"]
    argv += ["--save-cover"] if o.get("cover") else ["--no-cover"]
    if o.get("batch"):
        argv += ["-b"]
    if o.get("overwrite"):
        argv += ["-w"]
    argv += ["-d", str(files_dir(job.sid))]     # 落进本会话自己的目录（公开模式）
    return argv


def probe_audio_kbps(path: Path) -> int:
    rc, out = run_capture(["ffprobe", "-v", "error", "-select_streams", "a:0",
                           "-show_entries", "stream=bit_rate", "-of",
                           "default=noprint_wrappers=1:nokey=1", str(path)], timeout=40)
    try:
        return int((out or "0").strip().splitlines()[0]) // 1000
    except Exception:
        return 0


def transcode_to_mp3(src: Path, job: Job) -> Path | None:
    """把 m4a 按源码率（上限 320k）转成 MP3，成功后删掉中间文件。"""
    src_k = probe_audio_kbps(src)
    target = 320 if src_k >= 256 or src_k == 0 else max(128, min(320, src_k))
    dst = src.with_suffix(".mp3")
    job.phase = f"转 MP3（{target}k）"
    job.log(f"[转码] 源音频约 {src_k or '未知'} kbps -> MP3 {target}k（ffmpeg/libmp3lame）")
    rc, out = run_capture(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                           "-i", str(src), "-vn", "-c:a", "libmp3lame",
                           "-b:a", f"{target}k", str(dst)], timeout=900)
    if rc != 0 or not dst.exists():
        job.log(f"[转码] 失败（{rc}）：{(out or '')[-300:]}")
        return None
    try:
        src.unlink()
    except OSError:
        pass
    return dst


def preflight(job: Job) -> None:
    """用 yt-dlp 取标题/时长/预计体积。失败不阻塞下载。"""
    if ENGINE != "bili":
        # 小红书没有 yt-dlp 支持（其 extractor 已坏），不做预取：
        # 标题等由 XHS-Downloader 的产物文件名体现，进度用"已写入字节"表达
        job.phase = "解析链接"
        job.log(f"[引擎] XHS-Downloader（匿名 + 链接自带 xsec_token）")
        return
    job.phase = "解析链接"
    rc, out = run_capture([sys.executable, "-m", "yt_dlp", "-J", "--no-playlist",
                           "--no-warnings", job.url], timeout=90)
    if rc != 0 or not out.strip().startswith("{"):
        job.log("[预取] 解析失败，直接开始下载（进度可能不显示百分比）")
        job.log((out or "").strip()[-500:])
        return
    try:
        info = json.loads(out)
    except Exception:
        job.log("[预取] 返回内容无法解析，跳过")
        return
    job.meta = {
        "title": info.get("title"),
        "uploader": info.get("uploader") or info.get("channel"),
        "duration": info.get("duration"),
        "thumbnail": info.get("thumbnail"),
        "webpage": info.get("webpage_url"),
    }
    job.expected = estimate_bytes(info, job.opts.get("mode", "video"), job.opts.get("quality", "best"))
    job.log(f"[预取] {job.meta.get('title')}")
    if job.meta.get("duration"):
        job.log(f"[预取] 时长 {round(job.meta['duration'] / 60, 2)} 分钟，"
                f"预计体积 {round(job.expected / 1048576, 1)} MB")


def run_job(job: Job) -> None:
    job.state = "running"
    job.t0 = time.time()
    d = files_dir(job.sid)
    job.baseline = dir_total_bytes(d)
    job.files_before = {p.name for p in d.iterdir() if p.is_file()}

    if job.kind == "download":
        preflight(job)
    elif job.kind == "login":
        job.phase = "等待扫码"

    if job.kind == "download":
        argv = {"xhs": xhs_argv, "music": music_argv}.get(ENGINE, yutto_argv)(job)
    elif ENGINE == "music":
        argv = ne_login_argv(job)
    else:
        argv = [sys.executable, "-m", "yutto", "auth", "login", "--timeout", "300"] + \
            (["--auth-file", str(session_auth_file(job.sid))] if (PUBLIC_MODE and job.sid) else [])
    job.argv = argv
    job.log("$ " + " ".join(argv))
    if job.kind == "download":
        job.phase = "下载中"

    run_cwd = {"xhs": XHS_REPO, "music": NE_REPO}.get(
        ENGINE if job.kind == "download" else "", str(d))
    try:
        job.proc = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                    text=True, encoding="utf-8", errors="replace",
                                    bufsize=1, env=CHILD_ENV, cwd=run_cwd)
    except Exception as e:
        job.state = "failed"
        job.error = f"启动失败：{e}"
        job.phase = "失败"
        return

    for line in job.proc.stdout:                      # type: ignore[union-attr]
        job.log(line.rstrip("\n"))
    rc = job.proc.wait()
    job.elapsed = time.time() - job.t0

    # 登录成功后把凭据文件权限收紧到 600（只有 yslbili 自己能读）
    if job.kind == "login" and job.sid:
        af = session_auth_file(job.sid)
        if af.is_file():
            try:
                os.chmod(af, 0o600)
            except OSError:
                pass

    # 音频路径：yutto 产出 m4a -> 本地 ffmpeg 高码率转 MP3
    if (job.kind == "download" and rc == 0
            and job.opts.get("mode") == "audio"
            and job.opts.get("audio_out", "mp3") == "mp3"):
        made = [p for p in d.iterdir() if p.is_file() and p.suffix == ".m4a"
                and p.stat().st_mtime >= job.t0 - 5]
        for m4a in made:
            job.log(f"[转码] 处理 {m4a.name}")
            if transcode_to_mp3(m4a, job) is None:
                rc = -9

    touched = []
    for p in d.rglob("*"):
        try:
            if p.is_file() and p.suffix.lower() not in IGNORE_EXTS and p.stat().st_mtime >= job.t0 - 2:
                touched.append(p.name)
        except OSError:
            pass
    job.new_files = sorted(touched)

    if job.state == "canceled":
        job.phase = "已取消"
    elif rc == 0:
        job.state = "done"
        job.phase = "完成"
        job.log(f"[完成] 用时 {round(job.elapsed, 1)} 秒，"
                f"新增文件：{('、'.join(job.new_files) if job.new_files else '（无，可能已存在）')}")
    elif job.kind == "login" and rc != 0:
        job.state = "failed"
        job.phase = "登录未完成"
        job.error = "扫码超时或未确认，可重新点一次"
    else:
        job.state = "failed"
        job.phase = "失败"
        job.error = f"yutto 退出码 {rc}"


def queue_worker():
    while True:
        with QUEUE_LOCK:
            jid = QUEUE.popleft() if QUEUE else None
        if not jid:
            time.sleep(0.4)
            continue
        job = JOBS.get(jid)
        if job:
            try:
                run_job(job)
            except Exception as e:                    # 兜底，别让线程死掉
                job.state = "failed"
                job.phase = "失败"
                job.error = str(e)


threading.Thread(target=queue_worker, daemon=True).start()


def submit(url: str, opts: dict, kind: str = "download", sid: str = "") -> Job:
    job = Job(url, opts, sid)
    job.kind = kind
    JOBS[job.id] = job
    JOB_ORDER.append(job.id)
    if kind == "login":
        job.phase = "准备中"

        def _run():
            with LOGIN_LOCK:          # 登录之间串行即可，但不占下载槽
                run_job(job)

        threading.Thread(target=_run, daemon=True).start()
        return job
    with QUEUE_LOCK:
        busy = any(JOBS[i].state == "running" for i in JOB_ORDER)
        QUEUE.append(job.id)
    job.phase = "排队中" if busy else "准备中"
    return job


def cancel(job: Job):
    if job.proc and job.proc.poll() is None:
        job.state = "canceled"
        job.phase = "正在取消"
        try:
            if os.name == "nt":
                subprocess.run(["taskkill", "/F", "/T", "/PID", str(job.proc.pid)],
                               capture_output=True, env=CHILD_ENV)
            else:
                job.proc.terminate()
        except Exception:
            pass
        return True
    return False


def auth_status(auth_file: Path | None = None) -> dict:
    argv = [sys.executable, "-m", "yutto", "auth", "status"]
    if auth_file:
        argv += ["--auth-file", str(auth_file)]
    rc, out = run_capture(argv, timeout=40)
    text = out.strip()
    logged = ("未找到" not in text) and rc == 0
    return {"logged_in": logged, "raw": text[-400:]}


def env_status(auth_file: Path | None = None) -> dict:
    if ENGINE == "xhs":
        rc_y, out_y = run_capture([XHS_PY, os.path.join(XHS_REPO, "main.py"), "--version"], timeout=90)
        rc_d, out_d = 0, ""
    elif ENGINE == "music":
        rc_y, out_y = run_capture([NE_PY, "-c", "import pyncm;print(pyncm.__version__)"], timeout=60)
        rc_d, out_d = 0, ""
    else:
        rc_y, out_y = run_capture([sys.executable, "-m", "yutto", "--version"], timeout=30)
        rc_d, out_d = run_capture([sys.executable, "-m", "yt_dlp", "--version"], timeout=30)
    d = download_dir()
    free_gb = None
    try:
        free_gb = round(shutil.disk_usage(str(d)).free / 1024 ** 3, 1)
    except Exception:
        pass
    return {
        "yutto": {"ok": rc_y == 0,
                  "version": out_y.strip().splitlines()[0] if rc_y == 0 and out_y.strip() else None},
        # 注意：空字符串 splitlines() 返回空列表，直接取 [0] 会 IndexError（xhs 引擎下 rc_d=0 且 out_d=""
        # 就踩到了，表现为整个请求线程崩掉、外部只看到连接被断）
        "yt_dlp": {"ok": bool(rc_d == 0 and out_d.strip()),
                   "version": out_d.strip().splitlines()[0] if (rc_d == 0 and out_d.strip()) else None},
        "download_dir": str(d), "free_gb": free_gb,
        "auth": auth_status(auth_file) if ENGINE == "bili" else {"logged_in": False, "raw": {
            "xhs": "小红书走匿名分享链接，无需登录",
            "music": "网易云免登录取标准音质；扫码登录后可用更高音质",
        }.get(ENGINE, "")},
    }


# ----------------------------------------------------------------------------- HTTP
class Handler(BaseHTTPRequestHandler):
    server_version = "ysl-bili-web/1.0"

    def log_message(self, fmt, *args):                # 静音访问日志
        pass

    # ---- 通用
    def end_headers(self):
        sid = getattr(self, "_set_sid", None)
        if sid:
            cookie = f"ysl_sid={sid}; Path=/; HttpOnly; SameSite=Lax"
            if PUBLIC_MODE:
                cookie += "; Secure"
            try:
                self.send_header("Set-Cookie", cookie)
            except Exception:
                pass
        # 公开部署：禁止搜索引擎收录
        try:
            self.send_header("X-Robots-Tag", "noindex, nofollow, noarchive")
            self.send_header("Referrer-Policy", "no-referrer")
        except Exception:
            pass
        super().end_headers()

    def sid(self) -> str:
        """取会话 id；没有就新建（凭据按会话隔离，用完即毁）。"""
        if getattr(self, "_sid", None):
            return self._sid
        m = re.search(r"ysl_sid=([0-9a-f]{6,64})", self.headers.get("Cookie") or "")
        sid = m.group(1) if m else ""
        if not sid or not session_dir(sid).is_dir():
            sid = new_session()
            self._set_sid = sid
        else:
            self._set_sid = None
        self._sid = sid
        touch_session(sid)
        return sid

    def client_ip(self) -> str:
        if TRUST_PROXY:
            # 只信任「合法的单个 IP」：XFF 是客户端可控的请求头，直接拿它做额度键
            # 等于把限额交给攻击者（实测：换一个假 IP 额度就归零，2026-10-17 渗透测试）。
            # nginx 侧已改成用 $remote_addr 覆盖 XFF；这里再做一层兜底 + 截断（防超长值灌盘）。
            xff = (self.headers.get("X-Forwarded-For") or "")[:64]
            if xff:
                first = xff.split(",")[0].strip()
                try:
                    ipaddress.ip_address(first)
                    return first
                except ValueError:
                    pass
        return self.client_address[0]

    def is_admin(self) -> bool:
        if not ADMIN_PASSWORD:
            return not PUBLIC_MODE          # 本地模式无口令 = 视为管理员
        return self.headers.get("X-Admin-Token", "") == ADMIN_PASSWORD

    # ---- helpers
    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return {}
        try:
            return json.loads(self.rfile.read(n).decode("utf-8"))
        except Exception:
            return {}

    def _static(self, rel: str):
        target = (STATIC / rel.lstrip("/")).resolve()
        if not str(target).startswith(str(STATIC)) or not target.is_file():
            self.send_error(404)
            return
        ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        if target.suffix == ".js":
            ctype = "application/javascript; charset=utf-8"
        elif target.suffix in (".css", ".html"):
            ctype += "; charset=utf-8"
        data = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _index_html(self):
        """首页：注入 <base> 与引擎文案，并**在服务端整段剥离**不属于本引擎的区块。

        为什么要剥离：两个应用共用同一份 index.html，B站 专属区块（登录卡片/画质/弹幕勾选）
        若照原样发出去，只会被 JS 在拿到 /api/status 之后隐藏 —— 那 0.5~1 秒里页面会**先闪
        一下别的内容**（用户实测报过）。服务端剥离后：不闪，且 JS 挂了也仍然正确。
        """
        try:
            html = (STATIC / "index.html").read_text(encoding="utf-8")
        except OSError as e:
            self.send_error(500, str(e))
            return
        for tag, keep in (("BILI-ONLY", ENGINE == "bili"), ("XHS-ONLY", ENGINE == "xhs"),
                          ("MUSIC-ONLY", ENGINE == "music")):
            pat = re.compile(r"<!--" + tag + r"-->.*?<!--/" + tag + r"-->", re.S)
            html = pat.sub((lambda m: m.group(0)) if keep else "", html)
            html = html.replace("<!--" + tag + "-->", "").replace("<!--/" + tag + "-->", "")
        t = PAGE_TEXT.get(ENGINE, PAGE_TEXT["bili"])
        sub = t["sub_public"] if PUBLIC_MODE else t["sub_local"]
        for token, val in (("<!--BASE-->", f'<base href="{BASE_PATH or ""}/">'),
                           ("<!--TITLE-->", t["title"]),
                           ("<!--BRAND-->", t["brand"]),
                           ("<!--ICON-->", t["icon"]),
                           ("<!--H1-->", t["h1"]),
                           ("<!--URL-PH-->", t["url_ph"]),
                           ("<!--ENGINE-->", ENGINE),
                           ("<!--SUB-->", sub)):
            html = html.replace(token, val)
        # 兜底自检：共用一份 HTML，谁把「对方引擎」的文案写进公共区块，这里就会在 journalctl 里报出来
        # （这类残留只靠 JS 修 = 首屏闪一下对方内容，用户实测报过）
        foreign = {"xhs": ("bilibili",), "music": ("bilibili", "xiaohongshu"),
                   "bili": ("xiaohongshu",)}.get(ENGINE, ())
        hit = [k for k in foreign if k in html.lower()]
        if hit:
            print(f"[warn] index.html 里残留了 {hit} 文案（引擎={ENGINE}），首屏会闪", file=sys.stderr)
        body = html.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    # ---- 文件下载（支持 Range，方便网页里直接预览 mp4）
    def _file(self, name: str, inline: bool):
        d = files_dir(self.sid())          # 只在自己的会话目录里找文件
        target = (d / name).resolve()
        if not str(target).startswith(str(d.resolve())) or not target.is_file():
            self.send_error(404)
            return
        size = target.stat().st_size
        ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        disp = "inline" if inline else "attachment"
        # 中文文件名必须百分号编码后再进 HTTP 头：http.server 用 latin-1 编码头部，
        # 直接塞非 ASCII 会抛 UnicodeEncodeError（nginx 那边看到的就是 502）
        disp_name = quote(name, safe="")
        rng = self.headers.get("Range") or ""
        m = re.match(r"bytes=(\d*)-(\d*)", rng)
        start, end = 0, size - 1
        code = 200
        if m:
            if m.group(1):
                start = int(m.group(1))
            if m.group(2):
                end = min(int(m.group(2)), size - 1)
            code = 206
        length = max(0, end - start + 1)
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        self.send_header("Content-Disposition",
                         f"{disp}; filename*=UTF-8''{disp_name}")
        if code == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        with open(target, "rb") as fh:
            fh.seek(start)
            left = length
            while left > 0:
                chunk = fh.read(min(262144, left))
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    break
                left -= len(chunk)

    # ---- routes
    def do_GET(self):
        path = urlparse(self.path).path
        if path in ("/", "/index.html"):
            return self._index_html()
        if path == "/api/music/list" and ENGINE == "music":
            # 歌单只读接口：跑 ne_dl.py --list，把曲目清单回给页面（不产生下载任务、不扣额度）
            u = ""
            for kv in (urlparse(self.path).query or "").split("&"):
                if kv.startswith("url="):
                    u = unquote(kv[4:])
            if not u:
                return self._json({"error": "缺少 url 参数"}, 400)
            rc, out = run_capture([NE_PY, os.path.join(NE_REPO, "ne_dl.py"),
                                   "-u", u, "-o", "/tmp", "--list"], timeout=120)
            line = next((l for l in out.splitlines() if l.startswith("MUSIC_LIST ")), "")
            if not line:
                return self._json({"error": "读不到歌单曲目", "raw": out[-300:]}, 502)
            return self._json(json.loads(line[len("MUSIC_LIST "):]))
        if path == "/api/ne-auth" and ENGINE == "music":
            return self._json({"logged_in": (files_dir(self.sid()) / ".ne_cookie").is_file()})
        if path == "/api/status":
            sid = self.sid()
            af = session_auth_file(sid) if session_has_auth(sid) else None
            st = env_status(af)
            q = quota_state()
            ip = self.client_ip()
            st.update({
                "public": PUBLIC_MODE,
                "engine": ENGINE,
                "admin_required": bool(ADMIN_PASSWORD) and PUBLIC_MODE,
                "retention_hours": RETENTION_HOURS,
                "retention_text": fmt_retention(),
                "session": {"has_bili_auth": bool(af), "ttl_minutes": SESSION_TTL // 60},
                "quota": {"global_limit": GLOBAL_DAILY, "global_used": q.get("total", 0),
                          "per_ip_limit": PER_IP_DAILY, "per_ip_used": q.get("ips", {}).get(ip, 0)},
                "is_admin": self.is_admin(),
            })
            return self._json(st)
        if path == "/api/session":
            sid = self.sid()
            return self._json({"has_bili_auth": session_has_auth(sid),
                               "ttl_minutes": SESSION_TTL // 60})
        if path == "/api/files":
            self.sid()      # 顺带建立/续期会话 cookie（真正的响应在下面那个同名分支）
        if path == "/robots.txt":
            body = b"User-agent: *\nDisallow: /\n"
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if path == "/api/settings":
            return self._json({"download_dir": str(download_dir()),
                               "defaults": CFG.get("defaults"),
                               "quality_options": QUALITY_LABEL})
        if path == "/api/jobs":
            return self._json({"jobs": [JOBS[i].snapshot() for i in JOB_ORDER[-12:]][::-1]})
        if path.startswith("/api/job/"):
            job = JOBS.get(path.rsplit("/", 1)[-1])
            return self._json(job.snapshot() if job else {"error": "no such job"}, 200 if job else 404)
        if path == "/api/files":
            mydir = files_dir(self.sid())
            return self._json({"dir": str(mydir), "files": list_files(mydir)})
        if path.startswith("/files/"):
            return self._file(unquote(path[len("/files/"):]), inline=True)
        if path.startswith("/dl/"):
            return self._file(unquote(path[len("/dl/"):]), inline=False)
        if path.startswith("/static/"):
            return self._static(path[len("/static/"):])
        self.send_error(404)

    def do_POST(self):
        path = urlparse(self.path).path
        body = self._read_json()
        if path == "/api/job":
            # 音乐引擎的输入既可以是链接也可以是关键词 → 不走链接白名单
            raw = str(body.get("url") or "").strip()
            urls = ([raw] if raw else []) if ENGINE == "music" else normalize_url(body.get("url", ""))
            if not urls:
                return self._json({
                    "error": ("没找到小红书链接。请在小红书里点「分享 → 复制链接」，"
                              "把带 xsec_token 的分享链接（或 xhslink 短链）粘进来。")
                    if ENGINE == "xhs" else
                    ("请粘贴网易云歌曲链接，或直接输入歌名关键词" if ENGINE == "music"
                     else "无法识别的链接，请粘贴 B 站视频链接或 BV 号")}, 400)
            ok, why = quota_charge(self.client_ip())
            if not ok:
                return self._json({"error": why}, 429)
            if ENGINE == "music":
                opts = {"urls": urls, "level": str(body.get("level") or "standard"),
                        "cookie": str(body.get("cookie") or "")[:4000],
                        "preview": bool(body.get("preview")),
                        "mode": "music", "quality": ""}
            elif ENGINE == "xhs":
                opts = {
                    "urls": urls,
                    "image_format": str(body.get("image_format") or "auto"),
                    "note_format": str(body.get("note_format") or ""),
                    "live": bool(body.get("live")),
                    "cover": bool(body.get("cover")),
                    "index": str(body.get("index") or ""),
                    # 视频笔记挑流偏好：前端「视频优先」下拉 → xhs_argv 的 --video_preference。
                    # 少这一行 = 前端发得再对也到不了引擎（2026-10-16 就是这样"配好了却不生效"）
                    "video_pref": str(body.get("video_pref") or "resolution"),
                    "folder_mode": bool(body.get("folder_mode")),
                    "write_mtime": bool(body.get("write_mtime")),
                    "mode": "xhs",
                    "quality": "",
                }
            else:
                opts = {
                    "urls": urls,
                    "mode": "audio" if body.get("mode") == "audio" else "video",
                    "quality": str(body.get("quality") or "best"),
                    "danmaku": bool(body.get("danmaku")),
                    "subtitle": bool(body.get("subtitle", True)),
                    "cover": bool(body.get("cover")),
                    # 公开模式下禁用"整个合集"，防止有人一次拉走整部番
                    "batch": False if PUBLIC_MODE else bool(body.get("batch")),
                    "overwrite": bool(body.get("overwrite")),
                }
            job = submit(urls[0], opts, sid=self.sid())
            return self._json({"id": job.id, "urls": urls, "opts": opts})
        if path == "/api/login":
            # 每个人的会话用自己的 B站 账号登录；凭据只落在该会话目录，用完即毁
            if ENGINE == "xhs":
                return self._json({"error": "小红书走匿名分享链接，不需要登录"}, 400)
            # 音乐引擎：走 pyncm 扫码（ne_login.py），登录态落在本会话目录
            sid = self.sid()
            (session_dir(sid)).mkdir(parents=True, exist_ok=True)
            try:
                os.chmod(session_dir(sid), 0o700)
            except OSError:
                pass
            job = submit("", {"kind": "login"}, kind="login", sid=sid)
            return self._json({"id": job.id})
        if path == "/api/session/destroy":
            ok = destroy_session(self.sid())
            return self._json({"destroyed": ok,
                               "note": "该会话的 B站 凭据与已下载文件已从服务器删除；需要时重新扫码即可"})
        if path.startswith("/api/cancel/"):
            job = JOBS.get(path.rsplit("/", 1)[-1])
            ok = cancel(job) if job else False
            return self._json({"canceled": ok})
        if path == "/api/open-folder":
            if PUBLIC_MODE:
                return self._json({"ok": False, "error": "服务器模式下由你在浏览器里直接下载文件"}, 400)
            if not self.is_admin():
                return self._json({"ok": False, "error": "需要管理口令"}, 403)
            try:
                if os.name == "nt":
                    os.startfile(str(download_dir()))     # noqa: S606
                else:
                    subprocess.Popen(["xdg-open", str(download_dir())])
                return self._json({"ok": True})
            except Exception as e:
                return self._json({"ok": False, "error": str(e)}, 500)
        if path == "/api/settings":
            if not self.is_admin():
                return self._json({"error": "需要管理口令"}, 403)
            if body.get("download_dir"):
                with CFG_LOCK:
                    CFG["download_dir"] = str(Path(body["download_dir"]))
                    save_config(CFG)
                download_dir()
            return self._json({"download_dir": str(download_dir())})
        self.send_error(404)


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    download_dir()
    wipe_all_sessions()
    url = f"http://{LISTEN_HOST}:{LISTEN_PORT}/"
    title = {"xhs": "小红书下载器（XHS-Downloader）",
             "music": "音乐下载器（网易云 · pyncm）"}.get(ENGINE, "B站下载器（网页版 yutto）")
    print("=" * 62)
    print(f"  云树灵 · {title} 已启动"
          + ("  [公开模式]" if PUBLIC_MODE else "  [本地模式]"))
    print(f"  请在浏览器打开：{url}")
    print(f"  下载目录：{download_dir()}")
    if PUBLIC_MODE:
        print(f"  限额：每人每天 {PER_IP_DAILY} 次 / 全站每天 {GLOBAL_DAILY} 次 / 单任务串行")
        print(f"  文件保留 {fmt_retention()}，超期自动清理（每分钟扫一次）")
        if ENGINE == "xhs":
            print("  凭据：不需要（小红书走匿名分享链接）")
        elif ENGINE == "music":
            print(f"  凭据：按会话隔离（{SESSIONS_DIR}），扫码登录后可用；闲置或重启即销毁")
        else:
            print(f"  B站 凭据：按会话隔离（{SESSIONS_DIR}），闲置 {SESSION_TTL // 60} 分钟或重启即销毁")
        print(f"  管理口令：{'已设置' if ADMIN_PASSWORD else '⚠ 未设置（登录接口将拒绝）'}")
    print("  关闭本窗口即停止服务（Ctrl+C）")
    print("=" * 62)
    if "--no-browser" not in sys.argv:
        try:
            import webbrowser
            threading.Timer(1.0, lambda: webbrowser.open(url)).start()
        except Exception:
            pass
    srv = ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), Handler)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")


if __name__ == "__main__":
    main()
