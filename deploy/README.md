# Teacher registration gate — deployment notes

This directory contains the nginx and systemd wiring for the Nuxt-Admin
registration/membership gate. It is a deployment template; it is not applied
to the live server by this repository alone.

## Target layout

```text
/opt/teacher-admin/
  .output/                  # Nuxt-Admin production build
  .env                      # DATABASE_URL, SESSION_SECRET, ...

/www/wwwroot/teacher.yunshuling.com/
  index.html                # existing static portal (phase 1)
  apps.js
  ...
```

## Required environment

```dotenv
DATABASE_URL=postgres://USER:PASSWORD@127.0.0.1:5432/teacher_admin
SESSION_SECRET=replace-with-openssl-rand-hex-32
NUXT_PUBLIC_SITE_URL=https://teacher.yunshuling.com
AUTO_MIGRATE=false
TRUST_PROXY=true
SEED_ADMIN_PASSWORD=choose-a-strong-initial-password
# SEED_ADMIN_EMAIL=admin@example.com
```

Keep `.env` at mode `600` and owned by the service user. Never commit it.

## First deploy

1. Create a local PostgreSQL database and a dedicated database user.
2. Build Nuxt-Admin on Linux (or CI), not on the production VPS:

   ```bash
   pnpm install --frozen-lockfile
   pnpm db:migrate
   pnpm build
   ```

3. Copy `.output` to `/opt/teacher-admin/.output`.
4. Install `deploy/systemd/ysl-teacher-admin.service`.
5. Start the service and verify `curl -i http://127.0.0.1:8781/login`.
6. Back up the current nginx vhost, apply `deploy/nginx/teacher.yunshuling.com.conf`,
   then run `/www/server/nginx/sbin/nginx -t` before reloading.

## Acceptance checks

```bash
# Anonymous users must not reach protected tools
curl -i https://teacher.yunshuling.com/bili/
# Expect 302 to /login?next=/bili/

# Public portal remains public
curl -o /dev/null -w '%{http_code}\n' https://teacher.yunshuling.com/
# Expect 200

# Nuxt assets and auth API are reachable
curl -o /dev/null -w '%{http_code}\n' https://teacher.yunshuling.com/login
curl -o /dev/null -w '%{http_code}\n' https://teacher.yunshuling.com/api/auth/me
```

Registration creates an active `memberships` row immediately. To suspend a
user later, set `memberships.status` to `suspended` or set an `expires_at`
timestamp; the `/_auth` gate will return 403.
