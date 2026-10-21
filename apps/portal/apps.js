/* 应用清单：以后新增老师应用 = 在这里加一条数据（+ 服务器加目录/nginx location）。
   group 决定它归到哪一类（取素材 / 处理素材 / 备课与其它）。
   href 用相对路径（同域）或完整网址（外部应用）；status: live | soon            */
const GROUPS = [
  { id: "get", title: { en: "Get materials", zh: "取素材" },
    note: { en: "Paste a link, get the file back", zh: "粘链接，把素材取回来" } },
  { id: "edit", title: { en: "Edit media", zh: "处理素材" },
    note: { en: "Runs in your own browser — nothing uploaded", zh: "全部在你自己的浏览器里跑，不上传" } },
  { id: "prep", title: { en: "Lesson prep & more", zh: "备课与其它" },
    note: { en: "", zh: "" } },
];

const APPS = [
  {
    id: "bili",
    group: "get",
    href: "bili/",
    icon: "🎬",
    iconImg: "assets/icons/bili.png",
    status: "live",
    mark: { en: "Server-side", zh: "服务器端" },
    title: { en: "Bilibili Downloader", zh: "B站下载器" },
    desc: {
      en: "Paste a link, choose a format — full MP4 or audio-only MP3 — and download. Files are private to your session and are deleted from the server within an hour.",
      zh: "粘贴链接，选格式（完整 MP4 或只要音频 MP3），下载即可。文件只对你自己可见，服务器 1 小时内自动删除。"
    }
  },
  {
    id: "xhs",
    group: "get",
    href: "xhs/",
    icon: "📕",
    iconImg: "assets/icons/xhs.png",
    status: "live",
    mark: { en: "Server-side", zh: "服务器端" },
    title: { en: "Xiaohongshu Downloader", zh: "小红书下载器" },
    desc: {
      en: "Paste a share link from the Xiaohongshu app and grab the original images or video — no watermark, no login. Works with image notes, video notes, Live Photos and note captions.",
      zh: "把小红书 App 里的「分享 → 复制链接」粘进来，取回原图或原视频（无水印），不需要登录。图文、视频、Live Photo、文案都支持。"
    }
  },
  {
    id: "music",
    group: "get",
    href: "music/",
    icon: "🎵",
    iconImg: "assets/icons/ne.png",
    status: "live",
    mark: { en: "Server-side", zh: "服务器端" },
    title: { en: "Music Downloader", zh: "音乐下载器" },
    desc: {
      en: "Paste a song link, a playlist or an album — or just type the song name — and get an MP3 back. Preview the first 30 seconds of any track before you keep it.",
      zh: "粘歌曲链接、歌单或专辑，也可以直接输歌名，拿回 MP3。列表里可以只试听前 30 秒，满意再取整首。"
    }
  },
  {
    id: "rotate",
    group: "edit",
    href: "media/rotate/",
    icon: "🔄",
    status: "live",
    mark: { en: "In-browser", zh: "浏览器本地" },
    title: { en: "Video Rotate", zh: "视频旋转" },
    desc: {
      en: "Turn a sideways clip the right way up. Runs in your browser — nothing is uploaded.",
      zh: "把拍横/拍竖反了的视频转正。全在浏览器里跑，不上传任何东西。"
    }
  },
  {
    id: "mute",
    group: "edit",
    href: "media/mute/",
    icon: "🔇",
    status: "live",
    mark: { en: "In-browser", zh: "浏览器本地" },
    title: { en: "Remove Audio", zh: "去除音轨" },
    desc: {
      en: "Strip the soundtrack out of a clip — handy when you want to add your own narration.",
      zh: "把视频里的声音去掉，方便配上你自己的讲解。"
    }
  },
  {
    id: "audio",
    group: "edit",
    href: "media/audio/",
    icon: "🎵",
    status: "live",
    mark: { en: "In-browser", zh: "浏览器本地" },
    title: { en: "Extract Audio", zh: "提取音频" },
    desc: {
      en: "Pull the audio track out of a video as an MP3.",
      zh: "把视频里的音频提取成 MP3。"
    }
  },
  {
    id: "compress",
    group: "edit",
    href: "media/compress/",
    icon: "📦",
    status: "live",
    mark: { en: "In-browser", zh: "浏览器本地" },
    title: { en: "Compress Video", zh: "视频压缩" },
    desc: {
      en: "Shrink a big clip so it uploads, plays or emails easily.",
      zh: "把大视频压小，方便上传、播放或发送。"
    }
  },
  {
    id: "mosaic",
    group: "edit",
    href: "media/mosaic/",
    icon: "🫥",
    status: "live",
    mark: { en: "New · In-browser", zh: "新增 · 浏览器本地" },
    title: { en: "Video Mosaic", zh: "视频打码" },
    desc: {
      en: "Blur a face, a name tag or a watermark before a clip goes into a slide.",
      zh: "给视频里的人脸、胸牌或水印打码，再放进课件。"
    }
  },
  {
    id: "chalkline",
    group: "prep",
    href: "https://chalkline.yunshuling.com/",
    external: true,
    icon: "📝",
    iconImg: "assets/icons/chalkline.png",   // 与 chalkline.yunshuling.com 的 /chalkline-mark.png 同一枚（md5 校验）
    status: "live",
    mark: { en: "Web app", zh: "网页应用" },
    title: { en: "Chalkline", zh: "Chalkline 练习题生成" },
    desc: {
      en: "Lesson material in, finished practice out: drop in a PDF or Word file and get a printable practice sheet with an answer key.",
      zh: "课件进、练习出：丢一个 PDF 或 Word 进去，出来一份可打印的练习题，附答案。"
    }
  },
  {
    id: "face",
    group: "prep",
    href: "face/",
    pinned: true,
    icon: "🪪",
    iconImg: "assets/icons/face.png",
    status: "live",
    mark: { en: "Server-side · Staff", zh: "服务器端 · 员工自助" },
    title: { en: "Staff Face Enrollment", zh: "员工人脸采集" },
    desc: {
      en: "Each staff member fills in their name, department and phone, then takes a guided selfie. Admins export a photo folder plus CSV for the face terminal.",
      zh: "每位员工自己填姓名、部门、手机号，按引导拍一张正面照；管理员在后台统一导出照片目录和 CSV，导入人脸门禁。"
    }
  },
  {
    id: "soon",
    group: "prep",
    icon: "✦",
    status: "soon",
    title: { en: "More tools on the way", zh: "更多工具在路上" },
    desc: {
      en: "We add tools as teachers ask for them. Tell us the job that eats your evenings and it may end up here.",
      zh: "老师提什么需求，我们就做什么工具。把你最耗时间的活儿告诉我们，它可能就出现在这里。"
    }
  }
];

function cardEl(app, lang) {
  const soon = app.status === "soon";
  const el = document.createElement(soon ? "div" : "a");
  el.className = "card" + (soon ? " card-soon" : "");
  if (!soon) {
    el.href = app.href;
    if (app.external) { el.target = "_blank"; el.rel = "noopener"; }
  }
  const head = document.createElement("div");
  head.className = "card-head";
  head.innerHTML =
    `<span class="mark">${app.iconImg
        ? `<img src="${app.iconImg}" alt="" width="24" height="24">`
        : app.icon}</span>` +
    (app.pinned
      ? `<span class="badge badge-pin">${lang === "zh" ? "置顶" : "Pinned"}</span>`
      : "") +
    (app.status === "live"
      ? `<span class="badge badge-live">${lang === "zh" ? "已上线" : "Live"}</span>`
      : `<span class="badge badge-soon">${lang === "zh" ? "开发中" : "Coming soon"}</span>`);
  const title = document.createElement("h2");
  title.textContent = app.title[lang] || app.title.en;
  const desc = document.createElement("p");
  desc.textContent = app.desc[lang] || app.desc.en;
  el.append(head, title, desc);
  if (!soon) {
    const meta = document.createElement("div");
    meta.className = "card-meta";
    meta.innerHTML = `<span class="tag">${app.mark[lang] || app.mark.en}</span>` +
      `<span class="open">${lang === "zh" ? "打开" : "Open"} <span class="arrow">→</span></span>`;
    el.append(meta);
  }
  return el;
}

function groupHeader(text, note) {
  const h = document.createElement("div");
  h.className = "group-h";
  h.style.cssText = "grid-column:1/-1;display:flex;align-items:baseline;gap:10px;margin:18px 0 -4px;";
  const t = document.createElement("strong");
  t.style.cssText = "font-size:15px;";
  t.textContent = text;
  h.appendChild(t);
  if (note) {
    const s = document.createElement("small");
    s.style.cssText = "font-size:12px;color:rgba(16,21,25,.55);";
    s.textContent = note;
    h.appendChild(s);
  }
  return h;
}

function renderApps(lang) {
  const box = document.getElementById("apps");
  box.innerHTML = "";

  /* 置顶卡片：跨过分组，直接排在最前面 */
  const pinned = APPS.filter((a) => a.pinned);
  if (pinned.length) {
    box.append(groupHeader(
      lang === "zh" ? "置顶" : "Pinned",
      lang === "zh" ? "最常用的入口" : "Start here"
    ));
    pinned.forEach((app) => box.append(cardEl(app, lang)));
  }

  for (const g of GROUPS) {
    const items = APPS.filter((a) => a.group === g.id && !a.pinned);
    if (!items.length) continue;
    box.append(groupHeader(g.title[lang] || g.title.en, g.note[lang] || g.note.en));
    items.forEach((app) => box.append(cardEl(app, lang)));
  }
}
