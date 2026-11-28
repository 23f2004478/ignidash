# Native hosting (systemd, no Docker)

How this fork runs on a single Linux box without containers, reachable only over a
private network (Tailscale). `<host-ip>` below is the box's Tailscale address.
For the Docker route, see [SELF_HOSTING.md](SELF_HOSTING.md).

## Layout (as the service user)

```
~/apps/ignidash/                  this repo, branch india-inr
  .env.local                      mode 600: app + Convex env (see below)
  .next/standalone/server.js      what the web service runs
~/apps/convex-backend/
  bin/convex-local-backend        official precompiled release from get-convex/convex-backend
  secrets.env                     mode 600: INSTANCE_SECRET, CONVEX_SELF_HOSTED_ADMIN_KEY
  admin-key                       mode 600: the admin key alone, for scripts/convex-init.sh
  data/                           SQLite DB + file storage. THIS is the data to back up
~/.config/systemd/user/
  ignidash-convex.service
  ignidash-web.service
```

The admin key comes from the backend binary itself:
`convex-local-backend keygen admin-key --instance-name ignidash --instance-secret <secret>`.

## `.env.local`

```
SELF_HOSTED=true
SITE_URL=http://<host-ip>:3000
NEXT_PUBLIC_CONVEX_URL=http://<host-ip>:3210
NEXT_PUBLIC_CONVEX_SITE_URL=http://<host-ip>:3211     # baked into the build; unused at runtime
SELF_HOSTED_CONVEX_SITE_URL=http://<host-ip>:3210/http
BETTER_AUTH_SECRET=<openssl rand -hex 32>
CONVEX_API_SECRET=<openssl rand -hex 32>
FIREFLY_URL=http://<host-ip>:8090
FIREFLY_TOKEN=<Firefly Personal Access Token>
NEXT_TELEMETRY_DISABLED=1
```

## Units

`ignidash-convex.service`:

```
ExecStart=%h/apps/convex-backend/bin/convex-local-backend \
  --interface <host-ip> --port 3210 --site-proxy-port 3211 \
  --convex-origin http://<host-ip>:3210 --convex-site http://<host-ip>:3210/http \
  --instance-name ignidash --instance-secret ${INSTANCE_SECRET} \
  --local-storage %h/apps/convex-backend/data/storage \
  --disable-beacon --do-not-require-ssl \
  %h/apps/convex-backend/data/convex_local_backend.sqlite3
EnvironmentFile=%h/apps/convex-backend/secrets.env
```

`ignidash-web.service`: `node %h/apps/ignidash/.next/standalone/server.js` with
`WorkingDirectory=%h/apps/ignidash/.next/standalone`, `EnvironmentFile=.env.local`,
`HOSTNAME=<host-ip>`, `PORT=3000`, `NODE_ENV=production`. The build uses
`output: 'standalone'`, so `next start` is not supported.

### Why the site URL is `:3210/http`, not the `:3211` proxy

The backend's HTTP-actions proxy on 3211 forwards to `127.0.0.1:3210`. With the backend
bound to the private address only, nothing listens on loopback and every HTTP action
(all of Better Auth) fails with 500 "connection refused". The backend also serves HTTP
actions on its main port under `/http`, so `--convex-site` (the `CONVEX_SITE_URL` that
functions see) and `SELF_HOSTED_CONVEX_SITE_URL` (what the Next server uses) both point
there. Binding to `0.0.0.0` would also fix it but widens the listener; this way every
port stays on the private address.

## Redeploy after a change

```bash
cd ~/apps/ignidash && git pull
npm ci --no-audit --no-fund
set -a; . ./.env.local; set +a
CONVEX_BIN=$PWD/node_modules/.bin/convex \
CONVEX_SELF_HOSTED_URL=http://<host-ip>:3210 \
CONVEX_ADMIN_KEY_FILE=$HOME/apps/convex-backend/admin-key \
  sh scripts/convex-init.sh             # env vars, function deploy, migrations
NODE_OPTIONS=--max-old-space-size=3072 npm run build
rm -rf .next/standalone/.next/static .next/standalone/public
cp -r .next/static .next/standalone/.next/static && cp -r public .next/standalone/public
systemctl --user restart ignidash-web
```

Changing only `FIREFLY_TOKEN`: edit `.env.local`, then
`printf '%s' "$FIREFLY_TOKEN" | npx convex env set FIREFLY_TOKEN` with the same
`CONVEX_SELF_HOSTED_*` variables (or rerun `convex-init.sh`). No rebuild needed.

## Backups

Back up `~/apps/convex-backend/data/` (stop `ignidash-convex` first, or copy the SQLite
file with `sqlite3 .backup`) plus `secrets.env` and `.env.local`, which are needed to
read it back.
