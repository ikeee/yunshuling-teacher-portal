/* 云树灵 · 媒体工具页双语（EN 原文 → 中文）。默认跟随浏览器语言，右上角可切。
   为什么要"文本映射"而不是改 5 个页面的每个标签：这 5 页是同一套模板生成的静态页，
   直接映射文本节点改动最小、也不会破坏它们自己的 JS（2026-10-17）。 */
(function () {
  var KEY = "ysl_media_lang";
  var MAP = {
    "Lossless Video Rotate": "无损旋转视频",
    "Fix sideways or upside-down videos": "把拍歪/倒过来的视频转正",
    "Remove Audio from Video": "去掉视频里的声音",
    "Remove Audio (video untouched)": "去除音轨（画面不动）",
    "Extract Audio from Video": "从视频里提取音频",
    "Extract Audio (lossless)": "提取音频（无损）",
    "Compress Video": "压缩视频",
    "Video Mosaic": "视频打码",
    "← Teacher tools": "← 返回老师工具",
    "Drop a video here, or": "把视频拖到这里，或者",
    "choose a file": "选择文件",
    "Choose another file": "换一个文件",
    "MP4 / MOV supported": "支持 MP4 / MOV",
    "MP4 / MOV / WebM": "支持 MP4 / MOV / WebM",
    "MP4 / MOV with AAC audio": "支持 MP4 / MOV（AAC 音轨）",
    "↺ Rotate left 90°": "↺ 左转 90°",
    "↻ Rotate right 90°": "↻ 右转 90°",
    "⟲ Rotate 180°": "⟲ 转 180°",
    "Reset": "重置",
    "Rotation to apply:": "要旋转的角度：",
    "(preview updates live)": "（预览实时变化）",
    "Save & download (lossless)": "保存并下载（无损）",
    "Remove audio & download": "去掉声音并下载",
    "Remove audio — compact (smaller file, rebuilds container)": "去音轨 — 紧凑（文件更小，重建容器）",
    "Interval (seconds)": "区间（秒）",
    "Mark start": "标记起点",
    "Mark end": "标记终点",
    "Mute this range": "这段静音",
    "Beep over this range": "这段用提示音覆盖",
    "These re-encode the audio only — the video track is copied untouched.": "只重编码音频，视频轨原样复制。",
    "Lossless extract (.m4a)": "无损提取（.m4a）",
    "Convert to WAV": "转成 WAV",
    "Convert to MP3": "转成 MP3",
    "Target size": "目标大小",
    "Email-friendly — 10 MB": "邮件友好 — 10 MB",
    "Chat / LMS — 25 MB": "聊天 / 学习平台 — 25 MB",
    "Loose — 50 MB": "宽松 — 50 MB",
    "Custom…": "自定义…",
    "Auto-lower resolution if needed": "必要时自动降分辨率",
    "Compress": "压缩",
    "Show log": "显示日志",
    "Hide things in a video": "把视频里的东西挡住",
    "▶ Play / pause": "▶ 播放 / 暂停",
    "Clear box": "清除选框",
    "Drag on the preview to draw the box.": "在预览画面上拖动，画出要遮挡的框。",
    "Effect": "效果",
    "Mosaic": "马赛克",
    "Blur": "模糊",
    "Solid fill": "纯色遮挡",
    "Sticker 🙂": "贴纸 🙂",
    "Strength": "强度",
    "Follow motion (beta — works best on a steadily moving subject)": "跟随运动（测试中 — 目标稳定移动时最准）",
    "Record & download": "录制并下载"
  };
  var BACK = {};
  for (var k in MAP) BACK[MAP[k]] = k;
  var store = new WeakMap();

  function lang() {
    var s = localStorage.getItem(KEY);
    if (s === "zh" || s === "en") return s;
    return (navigator.language || "").toLowerCase().indexOf("zh") === 0 ? "zh" : "en";
  }
  function walk(root, fn) {
    var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var n;
    while ((n = w.nextNode())) fn(n);
  }
  function toZh() {
    walk(document.body, function (n) {
      var t = n.nodeValue, s = t.trim();
      if (MAP[s]) { if (!store.has(n)) store.set(n, t); n.nodeValue = t.replace(s, MAP[s]); }
    });
    if (MAP[document.title]) document.title = MAP[document.title];
  }
  function toEn() {
    walk(document.body, function (n) {
      var orig = store.get(n);
      if (orig !== undefined) { n.nodeValue = orig; store.delete(n); }
    });
  }
  function apply(l) {
    if (l === "zh") toZh(); else toEn();
    document.documentElement.lang = l === "zh" ? "zh-CN" : "en";
    document.querySelectorAll(".medi-lang button").forEach(function (b) {
      b.classList.toggle("on", b.dataset.lang === l);
    });
    try { localStorage.setItem(KEY, l); } catch (e) {}
  }
  function boot() {
    var head = document.querySelector("header") || document.body;
    var nav = document.createElement("nav");
    nav.className = "medi-lang";
    nav.style.cssText = "margin-left:auto;display:flex;gap:4px;background:#fff;border:1px solid rgba(16,21,25,.12);border-radius:999px;padding:3px";
    nav.innerHTML = '<button data-lang="en" style="border:0;background:transparent;font:inherit;font-size:12px;padding:5px 11px;border-radius:999px;cursor:pointer">EN</button>' +
                    '<button data-lang="zh" style="border:0;background:transparent;font:inherit;font-size:12px;padding:5px 11px;border-radius:999px;cursor:pointer">中文</button>';
    head.appendChild(nav);
    nav.addEventListener("click", function (e) {
      var b = e.target.closest("button[data-lang]");
      if (b) apply(b.dataset.lang);
    });
    apply(lang());
    // 动态渲染出来的文字（例如状态行）也一并翻译
    new MutationObserver(function (ms) {
      if (lang() !== "zh") return;
      ms.forEach(function (m) {
        m.addedNodes.forEach(function (n) { if (n.nodeType === 1) toZh(); });
      });
    }).observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
