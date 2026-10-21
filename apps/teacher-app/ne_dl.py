"""云树灵 · 网易云引擎（web app 的服务端下载器）。

为什么用 pyncm：纯 Python 实现网易云 weapi（加密自己算），**不需要浏览器、不需要 Node 服务**——
实测服务器（腾讯云机房 IP）能直接拿直链并以 0.1s 下载 2MB 音频（见错题本 #300）。

用法（被子进程调用，stdout 直接进任务日志）：
  python ne_dl.py -u "<分享链接 或 关键词>" -o <输出目录> [--level standard|higher|exhigh] [--cookie "k=v; k2=v2"]
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36")
BAD = re.compile(r'[\\/:*?"<>|\x00-\x1f]')


def log(m):
    print(m, flush=True)


def sanitize(name, limit=80):
    name = BAD.sub("_", (name or "").strip()).strip(" .")
    return (name[:limit] or "audio")


def link_kind(t):
    """认链接类型：playlist（歌单/榜单）/ album（专辑）/ dj（电台节目单集）/ song。"""
    s = t.lower()
    if "/album" in s or "album?id=" in s:
        return "album"
    if "/dj?" in s or "/program" in s or "dj?id=" in s:
        return "dj"
    if "/playlist" in s or "toplist" in s or "/discover" in s:
        return "playlist"
    return "song"


def fetch_html(url, timeout=25):
    """取公开网页 HTML（电台节目页里嵌着 mainSong，够我们用了）。"""
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")


def dj_program(pid):
    """电台节目（单集）：从公开节目页抠出 mainSong 的 id/名称/主播。"""
    html = fetch_html("https://music.163.com/program?id=" + str(pid))
    head = html.split('"program"', 1)[0] if '"program"' in html else html
    m = re.search(r'"mainSong":\{(.{0,3000}?)\},"', html, re.S)
    blob = m.group(1) if m else head
    sid = re.search(r'"id":(\d{5,})', blob)
    title = re.search(r'<title>([^<]{1,80})</title>', html)
    tname = (title.group(1).split(" - ")[0] if title else "")
    radio = ""
    tm = re.search(r"<title>[^<]{1,80} - ([^-<]{1,40}) - ", html)
    if tm:
        radio = tm.group(1).strip()
    artist = re.search(r'"artists":\[\{"name":"([^"]{1,40})"', blob)
    return {
        "id": int(sid.group(1)) if sid else 0,
        "name": tname or "电台节目",
        "artist": (artist.group(1) if artist else radio) or "电台",
    }

def parse_ids(text):
    """从分享链接里抠歌曲 id（支持 /song?id= / /song/123 / 短链跳转 / #/song?id=）。返回 [ids] 或 []。"""
    t = text.strip()
    if "163cn.tv" in t or "d.music.163.com" in t or re.match(r"^https?://\S+$", t):
        url = re.search(r"https?://\S+", t)
        if url and ("163cn.tv" in url.group(0) or "d.music.163.com" in url.group(0)):
            try:
                req = urllib.request.Request(url.group(0), headers={"User-Agent": UA})
                with urllib.request.urlopen(req, timeout=20) as r:
                    t = r.geturl()  # 短链 → 真实地址
                    log("[解析] 短链跳转到: " + t[:110])
            except Exception as e:
                log("[解析] 短链跳转失败，按原串继续: " + str(e)[:80])
    ids = re.findall(r"[?&#/](?:song[?/]?(?:id=)?|id=)(\d{5,})", t)
    if not ids:
        ids = re.findall(r"\b(\d{8,15})\b", t)
    return list(dict.fromkeys(ids))


def apply_cookie(cookie_str):
    if not cookie_str:
        return False
    import pyncm
    jar = {}
    for part in cookie_str.split(";"):
        if "=" in part:
            k, v = part.split("=", 1)
            jar[k.strip()] = v.strip()
    if not jar:
        return False
    try:
        s = pyncm.GetCurrentSession()
        s.cookies.update(jar)
        log("[登录] 已注入 {0} 个 cookie 字段（只在本会话内使用）".format(len(jar)))
        return True
    except Exception as e:
        log("[登录] cookie 注入失败: " + str(e)[:100])
        return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("-u", "--url", required=True, help="分享链接或关键词")
    ap.add_argument("-o", "--out", required=True, help="输出目录")
    ap.add_argument("--preview-sec", type=int, default=0,
                    help="只取前 N 秒（试听用；CDN 支持 Range，不用整首拉回来）")
    ap.add_argument("--level", default="standard", choices=["standard", "higher", "exhigh", "lossless"])
    ap.add_argument("--list", action="store_true", help="只列出曲目（歌单/榜单），不下载")
    ap.add_argument("--cookie", default="")
    ap.add_argument("--cookie-file", default="", help="从文件读 cookie（不让 cookie 进命令行/日志）")
    a = ap.parse_args()
    if a.cookie_file and not a.cookie:
        try:
            a.cookie = open(a.cookie_file, encoding="utf-8").read().strip()
        except OSError as e:
            log("[登录] 读 cookie 文件失败: " + str(e)[:80])

    out = os.path.abspath(a.out)
    os.makedirs(out, exist_ok=True)

    try:
        from pyncm import apis
    except Exception as e:
        log("[错误] pyncm 不可用: " + str(e)[:120])
        return 2

    logged = apply_cookie(a.cookie)
    ids = parse_ids(a.url)

    if a.list:
        kind = link_kind(a.url)
        pid = (ids or re.findall(r"\d{6,}", a.url) or [""])[0]
        if not pid:
            # 关键词（不是链接）：列出前 5 条让老师自己挑，不替他盲选
            kw = a.url.strip()
            if not kw:
                log("[错误] 没认出链接，也没有关键词")
                return 7
            log("[搜索] 关键词：" + kw)
            try:
                r = apis.cloudsearch.GetSearchResult(kw, stype=1, limit=5)
            except Exception as e:
                log("[错误] 搜索失败: " + str(e)[:150])
                return 3
            songs = (r.get("result") or {}).get("songs") or []
            if not songs:
                log("[错误] 没有搜到结果")
                return 3
            items = [{
                "id": s.get("id"),
                "name": s.get("name") or "",
                "artist": "、".join([ar.get("name") for ar in (s.get("ar") or []) if ar.get("name")]),
                "dur": s.get("dt") or 0,
                "fee": s.get("fee"),
            } for s in songs[:5]]
            log("[搜索] 找到 {0} 条，请挑一条".format(len(items)))
            print("MUSIC_LIST " + json.dumps(
                {"title": kw, "count": len(items), "kind": "search", "tracks": items},
                ensure_ascii=False), flush=True)
            return 0
        if kind == "album":
            try:
                _r = apis.album.GetAlbumInfo(pid)
            except Exception as e:
                log("[错误] 读专辑失败: " + str(e)[:150])
                return 7
            _al = _r.get("album") or {}
            songs = _r.get("songs") or _al.get("songs") or []
            title = _al.get("name") or ""
        elif kind == "dj":
            try:
                _pro = dj_program(pid)
            except Exception as e:
                log("[错误] 读电台节目失败: " + str(e)[:150])
                return 7
            if not _pro.get("id"):
                log("[错误] 节目页里没找到歌曲 id（可能是付费节目）")
                return 7
            log("[电台] {0}（{1}）-> 歌曲 id {2}".format(_pro["name"], _pro["artist"], _pro["id"]))
            songs = [{"id": _pro["id"], "name": _pro["name"], "ar": [{"name": _pro["artist"]}], "dt": 0, "fee": 0}]
            title = _pro["name"]
        else:
            try:
                tr = apis.playlist.GetPlaylistAllTracks(pid, offset=0, limit=1000)
            except Exception as e:
                log("[错误] 读歌单失败: " + str(e)[:150])
                return 7
            songs = tr.get("songs") or []
            title = ""
            try:
                title = (apis.playlist.GetPlaylistInfo(pid).get("playlist") or {}).get("name") or ""
            except Exception:
                pass
        _label = {"playlist": "歌单", "album": "专辑", "dj": "电台节目"}.get(kind, kind)
        log("[{0}] {1}：{2} 首".format(_label, title or pid, len(songs)))
        items = [{
            "id": s.get("id"),
            "name": s.get("name") or "",
            "artist": "、".join([ar.get("name") for ar in (s.get("ar") or []) if ar.get("name")]),
            "dur": s.get("dt") or 0,
            "fee": s.get("fee"),
        } for s in songs]
        print("MUSIC_LIST " + json.dumps(
            {"title": title, "count": len(items), "kind": kind, "tracks": items},
            ensure_ascii=False), flush=True)
        return 0

    _dj_meta = None
    if ids and link_kind(a.url) == "dj":
        # 电台节目链接直接下载：先解析成它那一首（同时记住节目名/主播，用于文件名）
        try:
            pro = dj_program(ids[0])
            if pro.get("id"):
                log("[电台] {0}（{1}）→ 歌曲 id {2}".format(pro["name"], pro["artist"], pro["id"]))
                _dj_meta = {"name": pro["name"], "artist": pro["artist"]}
                ids = [str(pro["id"])]
        except Exception as e:
            log("[警告] 解析电台节目失败，按原 id 继续: " + str(e)[:100])

    if ids:
        log("[输入] 识别为链接，歌曲 id: " + ", ".join(ids[:5]))
    else:
        kw = a.url.strip()
        log("[搜索] 关键词：" + kw)
        try:
            r = apis.cloudsearch.GetSearchResult(kw, stype=1, limit=5)
        except Exception as e:
            log("[错误] 搜索失败: " + str(e)[:150])
            return 3
        songs = (r.get("result") or {}).get("songs") or []
        if not songs:
            log("[错误] 没有搜到结果")
            return 3
        if a.list:
            # 搜索模式下不替老师做决定：把前 5 条列出来让他自己挑
            items = [{
                "id": s.get("id"),
                "name": s.get("name") or "",
                "artist": "、".join([ar.get("name") for ar in (s.get("ar") or []) if ar.get("name")]),
                "dur": s.get("dt") or 0, "fee": s.get("fee"),
            } for s in songs[:5]]
            log("[搜索] 找到 {0} 条，请挑一条".format(len(items)))
            print("MUSIC_LIST " + json.dumps(
                {"title": kw, "count": len(items), "kind": "search", "tracks": items},
                ensure_ascii=False), flush=True)
            return 0
        for s in songs:
            log("   {0} - {1}  (id={2})".format(
                ((s.get("ar") or [{}])[0].get("name") or "?"), (s.get("name") or "")[:30], s.get("id")))
        ids = [songs[0]["id"]]
        log("[搜索] 取第一条下载")

    # 歌曲信息
    meta = {}
    try:
        d = apis.track.GetTrackDetail(ids)
        for s in (d.get("songs") or []):
            meta[s["id"]] = s
    except Exception as e:
        log("[提示] 取歌曲信息失败（不影响下载）: " + str(e)[:100])

    # 直链
    try:
        u = apis.track.GetTrackAudioV1(ids, level=a.level)
    except Exception as e:
        log("[错误] 取直链失败: " + str(e)[:150])
        return 4

    ok = 0
    for item in (u.get("data") or []):
        sid, url = item.get("id"), item.get("url")
        s = meta.get(sid) or {}
        # 电台节目那一首在曲库里常常没有正经的 name/artist → 用节目页解析出来的补上
        if _dj_meta and not (s.get("name") or "").strip():
            s = {"name": _dj_meta["name"], "ar": [{"name": _dj_meta["artist"]}]}
        title = (s.get("name") or "歌曲{0}".format(sid))
        artist = "、".join([ar.get("name") for ar in (s.get("ar") or []) if ar.get("name")]) or "未知歌手"
        if not url:
            log("[跳过] {0} - {1}：平台没有给出可用音频（VIP 专享或已下版权），即便登录也拿不到"
                .format(artist, title))
            continue
        log("[直链] {0} - {1} | code={2} 码率={3} 体积={4}KB".format(
            artist, title, item.get("code"), item.get("br"), round((item.get("size") or 0) / 1024)))
        # 试听：按码率算出前 N 秒大约多少字节，用 Range 只取这一段（省流量、快到即时可听）
        span = 0
        if a.preview_sec > 0:
            br = item.get("br") or 0
            span = int(br / 8 * a.preview_sec) if br else 512 * 1024
            span = max(64 * 1024, int(span * 1.08))
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Referer": "https://music.163.com/"})
        if span:
            req.add_header("Range", "bytes=0-{0}".format(span - 1))
            log("[试听] 只取前 {0} 秒（约 {1} KB）".format(a.preview_sec, round(span / 1024)))
        tmp = os.path.join(out, ".tmp_dl")
        t0 = time.time()
        try:
            with urllib.request.urlopen(req, timeout=120) as r, open(tmp, "wb") as f:
                while True:
                    chunk = r.read(262144)
                    if not chunk:
                        break
                    f.write(chunk)
        except Exception as e:
            log("[错误] 下载失败: " + str(e)[:150])
            continue
        size = os.path.getsize(tmp)
        log("[下载] {0} 字节，用时 {1:.1f} 秒".format(size, time.time() - t0))

        head = open(tmp, "rb").read(4)
        name = sanitize("{0} - {1}".format(artist, title))
        if a.preview_sec > 0:
            name = sanitize("{0} - {1}（试听{2}秒）".format(artist, title, a.preview_sec))
        dst = os.path.join(out, name + ".mp3")
        if head[:3] == b"ID3" or head[:2] in (b"\xff\xfb", b"\xff\xf3"):
            os.replace(tmp, dst)          # 本来就是 MP3：不重编码（避免"128k 转 320k"这种假提升）
            log("[完成] 已是 MP3，直接保存：{0}.mp3".format(name))
        else:
            rc = subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", tmp, "-vn",
                                 "-c:a", "libmp3lame", "-b:a", "320k", dst]).returncode
            if rc != 0 or not os.path.exists(dst):
                log("[错误] ffmpeg 转码失败 rc=" + str(rc))
                continue
            os.remove(tmp)
            log("[完成] 转 MP3 320k：{0}.mp3".format(name))
        # Range 截断的 MP3 头里时长不准（播放器会显示整首时长却只放 30 秒）→
        # 本地用 ffmpeg 重写一次头（-c copy，不解码，几十毫秒）
        if a.preview_sec > 0 and os.path.exists(dst):
            fixed = dst + ".t.mp3"
            rc2 = subprocess.run(['ffmpeg', '-y', '-v', 'error', '-i', dst, '-t', str(a.preview_sec),
                                  '-c', 'copy', fixed]).returncode
            if rc2 == 0 and os.path.exists(fixed) and os.path.getsize(fixed) > 0:
                os.replace(fixed, dst)
                log("[试听] 已规范化为 {0} 秒片段（播放器时长才准）".format(a.preview_sec))
            elif os.path.exists(fixed):
                os.remove(fixed)

        ok += 1

    if ok:
        log("[汇总] 成功 {0} 首".format(ok))
        return 0
    log("[汇总] 没有产出文件（可能全部是 VIP 专享 / 已下版权）")
    return 5


if __name__ == "__main__":
    sys.exit(main())
