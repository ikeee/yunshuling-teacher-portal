/* Swap the header auth links when a Nuxt-Admin session is already present. */
(function () {
  const box = document.querySelector(".auth");
  if (!box || !window.yslText) return;

  fetch("/api/auth/me", { credentials: "same-origin" })
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      if (!data || !data.user) return;
      const isAdmin = data.user.role?.name === "admin";
      box.innerHTML = isAdmin
        ? '<a href="/dashboard" data-auth-label="dashboard"></a><a class="auth-register" href="/logout" data-auth-label="logout"></a>'
        : '<a href="/profile" data-auth-label="account"></a><a class="auth-register" href="/logout" data-auth-label="logout"></a>';
      box.querySelectorAll("[data-auth-label]").forEach((el) => {
        el.textContent = window.yslText(el.dataset.authLabel);
      });
    })
    .catch(() => { /* anonymous or unavailable: keep login/register */ });
})();
