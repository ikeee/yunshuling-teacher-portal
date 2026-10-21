"""网易云「扫码登录」引擎：服务端出二维码，老师用网易云 App 扫，cookie 只落本会话。

与 /bili/ 的 B站扫码同构：登录态存成 600 权限的 .ne_cookie，随后音乐任务自动带上它；
闲置/重启即销毁（app 启动时 wipe_all_sessions）。

stdout 直接进任务日志（用户可见），所以**只打印状态，绝不打印 cookie 值**。
"""
import argparse
import os
import sys
import time

sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def log(m):
    print(m, flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("-o", "--out", required=True)
    ap.add_argument("--timeout", type=int, default=300)
    a = ap.parse_args()
    out = os.path.abspath(a.out)
    os.makedirs(out, exist_ok=True)

    try:
        import qrcode
        from pyncm import apis
    except Exception as e:
        log("[错误] 依赖缺失（qrcode / pyncm）: " + str(e)[:140])
        return 2

    try:
        r = apis.login.LoginQrcodeUnikey()
        unikey = r.get("unikey") or (r.get("data") or {}).get("unikey")
    except Exception as e:
        log("[错误] 取二维码令牌失败: " + str(e)[:160])
        return 3
    if not unikey:
        log("[错误] 没拿到 unikey，返回: " + str(r)[:200])
        return 3

    url = apis.login.GetLoginQRCodeUrl(unikey)
    qr_path = os.path.join(out, "_login_qr.png")
    qrcode.make(url).convert("RGB").save(qr_path)
    # 关键：把二维码**以字符画打进任务日志**（和 /bili/ 的 B站扫码同一套前端渲染路径）。
    # 早先版本只存 PNG 文件、指望前端按会话取文件 → 登录 job 的 sid 与请求方 sid 不同源，
    # 取回来是 404（详见错题本 #302）。走日志就没有这个耦合。
    q = qrcode.QRCode(border=1, box_size=1)
    q.add_data(url)
    q.make(fit=True)
    q.print_ascii(invert=True)
    log("[二维码] 已生成，请用「网易云音乐」App 扫码（页面上的图会自动出现）")
    log("[说明] 扫码后手机上点确认；二维码约 5 分钟内有效")

    t0 = time.time()
    last = None
    while time.time() - t0 < a.timeout:
        try:
            s = apis.login.LoginQrcodeCheck(unikey)
        except Exception as e:
            log("[警告] 轮询异常（继续重试）: " + str(e)[:100])
            time.sleep(3)
            continue
        code = s.get("code")
        if code != last:
            if code == 801:
                log("[状态] 等待扫码…")
            elif code == 802:
                log("[状态] 已扫码，请在手机上点「确认登录」")
            elif code == 800:
                log("[状态] 二维码已过期，请重新点一次「扫码登录」")
                return 4
            elif code == 803:
                pass
            else:
                log("[状态] 返回码 {0}：{1}".format(code, str(s.get("message") or "")[:80]))
            last = code

        if code == 803:
            jar = s.get("cookie") or ""
            import pyncm
            ck = pyncm.GetCurrentSession().cookies
            parts = [p.strip() for p in jar.split(";") if "=" in p]
            names = {p.split("=", 1)[0].strip() for p in parts}
            if "MUSIC_U" not in names and ck.get("MUSIC_U"):
                parts.append("MUSIC_U=" + ck.get("MUSIC_U"))
            if ck.get("__csrf"):
                parts.append("__csrf=" + ck.get("__csrf"))
            cookie = "; ".join(dict.fromkeys(parts))
            if "MUSIC_U=" not in cookie:
                log("[错误] 登录返回成功但没拿到 MUSIC_U，无法使用")
                return 5
            with open(os.path.join(out, ".ne_cookie"), "w", encoding="utf-8") as f:
                f.write(cookie)
            try:
                os.chmod(os.path.join(out, ".ne_cookie"), 0o600)
            except OSError:
                pass
            log("[完成] 登录成功：已保存 {0} 个字段（"
                "字段名：" + "、".join(sorted({p.split("=", 1)[0].strip() for p in parts})) + "）")
            try:
                st = apis.login.GetCurrentLoginStatus()
                prof = (st.get("data") or {}).get("profile") or {}
                if prof.get("nickname"):
                    log("[完成] 当前账号：" + str(prof.get("nickname")))
            except Exception:
                pass
            return 0
        time.sleep(2)

    log("[超时] 没有等到扫码确认，请重新点一次「扫码登录」")
    return 6


if __name__ == "__main__":
    sys.exit(main())
