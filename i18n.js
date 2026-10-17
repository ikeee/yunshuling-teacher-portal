/* 双语切换：英语为默认；选择记在 localStorage，也支持 ?lang=zh 直达 */
const DICT = {
  en: {
    _title: "Teacher Tools — Yunshuling",
    brandSub: "Teacher Tools",
    heroTitle: "Tools for teachers",
    heroLede: "Small, sharp utilities that take the busywork out of teaching — practice generation, media handling, downloads. Built by a teacher, used in real classrooms.",
    note: "Authorized use only. Please respect platform terms and copyright — materials you fetch are for your own teaching preparation, not for redistribution.",
    needPass: "🔑 Need the password? Ask your administrator — it is not published anywhere."
  },
  zh: {
    _title: "老师工具集 — 云树灵",
    brandSub: "老师工具集",
    heroTitle: "为老师做的工具",
    heroLede: "把教学里的杂活干掉的小工具 —— 出题、处理素材、下载资源。由一线老师做，在自己的课堂里用。",
    note: "仅限授权使用。请遵守平台规则与著作权法 —— 取回的素材用于你自己备课，不要二次分发。",
    needPass: "🔑 需要口令？向管理员索取 —— 口令不在任何公开渠道发布。"
  }
};

let LANG = "en";   // 默认英文

function applyLang(lang) {
  LANG = DICT[lang] ? lang : "en";
  document.documentElement.lang = (LANG === "zh") ? "zh-CN" : "en";
  document.title = DICT[LANG]._title;
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.dataset.i18n;
    const val = DICT[LANG][key];
    if (val) el.textContent = val;
  });
  document.querySelectorAll(".langs button").forEach((b) => {
    b.classList.toggle("on", b.dataset.lang === LANG);
  });
  renderApps(LANG);
  try { localStorage.setItem("ysl_lang", LANG); } catch (e) { /* 忽略 */ }
}

document.querySelectorAll(".langs button").forEach((b) => {
  b.addEventListener("click", () => applyLang(b.dataset.lang));
});

(function init() {
  const q = new URLSearchParams(location.search).get("lang");
  let saved = null;
  try { saved = localStorage.getItem("ysl_lang"); } catch (e) { /* 忽略 */ }
  // 没指定也没存过 → 跟随浏览器语言（中文浏览器直接进中文）
  const auto = (navigator.language || "").toLowerCase().startsWith("zh") ? "zh" : "en";
  applyLang(q || saved || auto);
})();
