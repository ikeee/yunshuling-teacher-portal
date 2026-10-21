# B站下载器（网页版 yutto）

本地运行的网页界面，把命令行工具 [yutto](https://github.com/yutto-dev/yutto) 包成"粘链接 → 选格式 → 下载"。
一切都在你自己的电脑上执行，**不上传任何东西，也没有服务器**。

## 启动

双击 `start.cmd`，浏览器会自动打开 <http://127.0.0.1:8765/>。
（或命令行 `py -3 app.py`，加 `--no-browser` 则不自动开浏览器。）

## 依赖

```bash
pip install yutto yt-dlp
```

* `yutto` —— 下载引擎（GPL-3.0，本项目只是以子进程方式调用它，不含其代码）
* `yt-dlp` —— 只用来预取标题/时长/预计体积，给进度条做分母

## 功能

| 功能 | 说明 |
|---|---|
| 粘链接即用 | 支持完整链接、BV 号、av 号、番剧 `ep` 号；自动去掉推广参数 |
| 只要音频 | 一键 `--audio-only --output-format-audio-only mp3` |
| 画质档位 | 最高可用 / 1080P / 720P / 480P / 1080P60 / 4K / 8K |
| 附赠资源 | 弹幕（.ass）、字幕、封面，各自可开关 |
| 批量 | 「整个合集/系列」= yutto `-b` |
| 扫码登录 | 网页里直接显示二维码（块字符），手机 B站 App 扫码；登录态存在 `%APPDATA%\yutto\auth.toml` |
| 进度 | 预取预计体积 + 目录增长字节 → 真实百分比、已写入、用时 |
| 文件区 | 列表 / 网页内播放 mp4 / 另存为 / 打开文件夹 / 改保存位置 |

## 说明

* 只监听 `127.0.0.1`，外网访问不到。
* 未登录时 B站 只给 480P；登录后 1080P；1080P60 / 4K / 8K 需要大会员。
* 请遵守平台规则与著作权法，下载内容仅供个人学习研究使用。

## 部署

本仓库只含下载器应用本体；teacher.yunshuling.com 的 nginx / 门户 / 登录服务统一放在 [yunshuling-teacher-portal](https://github.com/ikeee/yunshuling-teacher-portal) 的 deploy/nginx/ 与 services/。
