"""teacher.yunshuling.com 线上端到端回归：门户 → 卡片 → /bili/ 子应用 → 真下载 → 零报错。

前提：本机自动化 Chrome 已在 9333 端口（D:\\YIN-PROJE\\_tools\\start-automation-chrome.ps1 -Port 9333）
用法：py -3 -X utf8 e2e_online.py
"""
import os, time
from playwright.sync_api import sync_playwright

CRED = {"username": os.environ.get("PORTAL_USER", "teacher"), "password": os.environ.get("PORTAL_PASSWORD", "")}
if not CRED["password"]:
    raise SystemExit("set PORTAL_PASSWORD env var")
BASE = "https://teacher.yunshuling.com"


def main():
    with sync_playwright() as p:
        b = p.chromium.connect_over_cdp("http://127.0.0.1:9333")
        ctx = b.new_context(http_credentials=CRED)
        pg = ctx.new_page()
        bad, errs = [], []
        pg.on("response", lambda r: bad.append(f"{r.status} {r.url}") if r.status >= 400 else None)
        pg.on("console", lambda m: errs.append(f"{m.type}: {m.text}") if m.type == "error" else None)
        pg.on("pageerror", lambda e: errs.append(f"pageerror: {e}"))

        pg.set_viewport_size({"width": 1280, "height": 950})
        pg.goto(BASE + "/", timeout=40000)
        time.sleep(2.5)
        assert pg.get_attribute("html", "lang") == "en", "门户默认语言不是英文"
        assert pg.locator("#apps a.card").count() >= 1, "门户没有可点卡片"
        print("门户 OK：", pg.inner_text("h1"))

        pg.locator("#apps a.card", has_text="Bilibili Downloader").first.click()
        pg.wait_for_load_state("domcontentloaded")
        time.sleep(2.5)
        assert pg.url.rstrip("/").endswith("/bili"), f"卡片跳转地址不对：{pg.url}"
        assert pg.get_attribute("base", "href") == "/bili/", "子路径 base 标签不对"
        print("卡片跳转 OK：", pg.url)

        pg.click('#mode button[data-v="audio"]')
        pg.fill("#url", "BV16VpH6pEbN")
        pg.click("#btn-start")
        for _ in range(40):
            time.sleep(3)
            if pg.inner_text("#phase") in ("完成", "失败", "已取消"):
                break
        phase = pg.inner_text("#phase")
        print("下载阶段：", phase, "|", pg.inner_text("#stat")[:70])
        assert phase == "完成", f"下载没有完成：{phase}"
        assert pg.locator("#files li").count() >= 1, "文件列表为空"
        assert not errs, f"控制台报错：{errs}"
        assert not bad, f"失败请求：{bad}"
        print("全部通过：无控制台报错、无失败请求")
        ctx.close()


if __name__ == "__main__":
    main()
