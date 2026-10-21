# 云树灵 Teacher Platform

`teacher.yunshuling.com` 的单一代码仓库（monorepo）：门户、下载器、媒体工具箱、人脸采集、登录服务、nginx 配置都在这里。

## 目录

| 路径 | 作用 | 线上位置 |
|---|---|---|
| `apps/portal/` | 教师工具门户（静态站） | `/www/wwwroot/teacher.yunshuling.com/` |
| `apps/teacher-app/` | B站/小红书/音乐下载器（Python） | `/opt/ysl-bili-web`、`/opt/ysl-xhs-web`、`/opt/ysl-music-web` |
| `apps/media-toolbox/` | 5 个纯前端媒体工具 | 门户下 `/media/` |
| `services/face-collect/` | 员工人脸采集 + 管理后台 | `/opt/face-collect` |
| `services/portal-auth/` | 门户 Cookie 登录服务 | `/opt/ysl-portal-auth` |
| `deploy/nginx/` | teacher.yunshuling.com nginx 配置 | `/www/server/panel/vhost/nginx/` |

## 本地开发

```bash
# 门户
cd apps/portal && py -3 -m http.server 8770 --bind 127.0.0.1

# 下载器（bili/xhs/music）
cd apps/teacher-app && py -3 app.py

# 媒体工具箱
cd apps/media-toolbox && py -3 -m http.server 8780 --bind 127.0.0.1
```

## 关键环境变量

- `services/portal-auth`：**必须设置 `PORTAL_PASSWORD`**（未设置时仅为占位 `CHANGE_ME`）；可选 `IDLE_MINUTES=30`、`SESSION_HOURS=12`。
- `apps/teacher-app`：`YSL_ADMIN_PASSWORD`（管理接口）、`YSL_ENGINE=bili|xhs|music`。
- `services/face-collect`：`ADMIN_PASSWORD`（可选）、`FC_DATA_DIR`（默认 `./data`）。

## 历史

2026-10-21 由三个仓库合并而来（保留各自 git 历史）：

- `ikeee/yunshuling-teacher-portal`
- `ikeee/yunshuling-teacher-app`
- `ikeee/yunshuling-media-toolbox`

旧仓库已归档，后续只维护本仓库。