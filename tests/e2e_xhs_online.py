"""小红书子应用线上端到端回归：
本地匿名信息流抓一条"带 xsec_token 的新鲜链接" → 打开 https://teacher.yunshuling.com/xhs/ → 走界面真下载 → 断言。

前提：本机自动化 Chrome 在 9333 端口（D:\\YIN-PROJE\\_tools\\start-automation-chrome.ps1 -Port 9333）
用法：py -3 -X utf8 e2e_xhs_online.py
"""
import random
import re
import time
from playwright.sync_api import sync_playwright

CRED = {"username": "teacher", "password": "REDACTED"}
BASE = "https://teacher.yunshuling.com"


def harvest_token_link(b) -> str:
    """从匿名信息流里抓一条带 xsec_token 的笔记链接（不带 token 的链接必然下载失败）。"""
    pg = b.contexts[0].new_page()
    found = []
    pg.on("response", lambda r: found.append(r.url) if ("xiaohongshu.com" in r.url and "xsec_token" in r.url) else None)
    pg.goto("https://www.xiaohongshu.com/explore", timeout=60000)
    time.sleep(5)
    pg.mouse.wheel(0, 2200)
    time.sleep(3)
    hrefs = pg.eval_on_selector_all(
        "a[href]",
        "els => els.map(e => e.getAttribute('href')).filter(h => h && h.includes('xsec_token'))")
    cands = [u for u in found + hrefs if "xsec_token" in u]
    pg.close()
    # 随机挑一条，避免每次都撞上"已下载过 → 跳过"的记录
    random.shuffle(cands)
    for u in cands:
        if u.startswith("/"):
            u = "https://www.xiaohongshu.com" + u
        u = u.split("&xsec_source=")[0] + "&xsec_source=pc_feed" if "&xsec_source=" in u else u
        if re.search(r"/(explore|discovery/item)/[\da-f]{16,}", u) and u.startswith("http"):
            return u
    raise SystemExit("没抓到带 token 的链接")


def main():
    with sync_playwright() as p:
        b = p.chromium.connect_over_cdp("http://127.0.0.1:9333")
        link = harvest_token_link(b)
        print("测试链接:", link[:120])

        ctx = b.new_context(http_credentials=CRED)
        pg = ctx.new_page()
        bad, errs = [], []
        pg.on("response", lambda r: bad.append(f"{r.status} {r.url}") if r.status >= 400 else None)
        pg.on("console", lambda m: errs.append(f"{m.type}: {m.text}") if m.type == "error" else None)
        pg.on("pageerror", lambda e: errs.append(f"pageerror: {e}"))

        pg.set_viewport_size({"width": 1280, "height": 950})
        pg.goto(BASE + "/xhs/", timeout=40000)
        time.sleep(2.5)
        assert pg.get_attribute("base", "href") == "/xhs/", "子路径 base 不对"
        assert pg.locator("#xhs-tip").is_visible(), "没有显示‘必须用分享链接’的提示"
        assert not pg.locator("#login-card").is_visible(), "小红书不该显示登录卡片"
        assert not pg.locator("#opt-quality").is_visible(), "小红书不该显示画质选择"
        assert pg.locator("#opt-imagefmt").is_visible(), "缺少图片格式选项"
        print("界面适配 OK（无登录卡片、无画质、有图片格式）")

        pg.fill("#url", link)
        pg.click("#btn-start")
        for _ in range(60):
            time.sleep(3)
            if pg.inner_text("#phase") in ("完成", "失败", "已取消"):
                break
        phase = pg.inner_text("#phase")
        print("阶段:", phase, "|", pg.inner_text("#stat")[:80])
        assert phase == "完成", f"下载未完成：{phase} / {pg.inner_text('#log')[-400:]}"
        n = pg.locator("#files li").count()
        print("文件数:", n)
        for i in range(min(n, 4)):
            print("   ", pg.locator("#files li").nth(i).inner_text().replace("\n", " | ")[:100])
        assert n >= 1, "文件列表为空"
        assert "还没有文件" not in pg.inner_text("#files"), "文件列表只显示了空状态占位（说明没扫到产物）"
        assert not errs, f"控制台报错：{errs}"
        assert not bad, f"失败请求：{bad}"
        print("全部通过：界面适配正确、真下载成功、无控制台报错、无失败请求")
        ctx.close()


if __name__ == "__main__":
    main()
