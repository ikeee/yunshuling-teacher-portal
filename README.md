# Teacher Tools 门户（teacher.yunshuling.com）

老师应用的门户站：**一个应用一张卡片**，点卡片跳到该应用。
风格与字体直接取自 `tools.yunshuling.com` 的线上设计变量（`--primary:#16624f`、`--paper:#ffffff`、
`--ink:#14181c`，字体 Fraunces + Inter + Noto Sans SC）。**英文为默认语言**，可切中文。

## 文件

| 文件 | 作用 |
|---|---|
| `index.html` | 页面骨架（品牌栏 / 标题 / 卡片容器 / 页脚），文案用 `data-i18n="key"` 占位 |
| `apps.js` | **应用清单**（新增应用只改这里）+ 卡片渲染 |
| `i18n.js` | 双语字典 + 切换逻辑（`localStorage.ysl_lang`，支持 `?lang=zh` / `?lang=en`） |
| `style.css` | 设计变量与卡片样式（含移动端断点） |
| `assets/` | `logo-official.jpg`（品牌 logo）、`favicon.svg`（取自 tools 站） |

## 新增一个应用的步骤

1. **在 `apps.js` 的 `APPS` 数组里加一条**：

```js
{
  id: "myapp",
  href: "myapp/",                 // 同域子路径；外部应用写完整 https 网址并加 external: true
  icon: "📐",
  status: "live",                 // live | soon
  mark: { en: "Server-side", zh: "服务器端" },
  title: { en: "My App", zh: "我的应用" },
  desc:  { en: "…", zh: "…" }
}
```

2. **服务器上给该应用加一条 nginx location**（以子路径应用为例，模板见下行），并确认应用本身能处理子路径
   （Python 版应用的写法：读 `YSL_BASE_PATH` 环境变量，首页注入 `<base href="/myapp/">`，前端 URL 一律用相对路径）。

```nginx
location ^~ /myapp/ {                 # ^~ 必须加：否则 *.js/*.css 正则 location 会抢走 /myapp/static/*
    proxy_pass http://127.0.0.1:<端口>/;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

3. 部署：`scp` 门户文件到 `/www/wwwroot/teacher.yunshuling.com/`，`chown -R www:www`；应用代码按各自方式部署。

## 本地预览

```bash
cd D:\YIN-PROJE\output\ysl-teacher-portal
py -3 -m http.server 8770 --bind 127.0.0.1     # 然后浏览器打开 http://127.0.0.1:8770/
```

## 回归测试

`tests/e2e_online.py`（需要本机自动化 Chrome 在 9333 端口）：
门户默认英文 → 点「Bilibili Downloader」卡片 → 落到 `/bili/` → 用界面真下载一次 →
断言无控制台报错、无失败请求、文件只在本会话可见。

## 附带服务（services/）

| 目录 | 作用 |
|---|---|
| `services/face-collect/` | 员工人脸采集 + 管理后台（Node，零依赖）；数据落 `data/`，默认不随仓库发布 |
| `services/portal-auth/` | 门户 Cookie 登录服务（Node + nginx `auth_request`） |
| `deploy/nginx/` | teacher.yunshuling.com 的 nginx 配置示例 |

### 环境变量

- `portal-auth`：**必须设置 `PORTAL_PASSWORD`**（不设置时仅为占位 `CHANGE_ME`）；可选 `IDLE_MINUTES`（默认 30）、`SESSION_HOURS`（默认 12）。
- `face-collect`：可选 `ADMIN_PASSWORD`（首次启动生成）、`FC_DATA_DIR`（默认 `./data`）。
- 不要把 `data/`、证书、真实密码提交进仓库（`services/face-collect/.gitignore` 已忽略）。
