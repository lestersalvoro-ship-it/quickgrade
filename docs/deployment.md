# Deployment

QuickGrade runs as **one Node.js process** with a **data directory** (`DATA_DIR`) holding the SQLite database (`quickgrade.db`, WAL mode) and private scan images (`uploads/`). Any host with a persistent disk and HTTPS works.

> Static or serverless hosts (Netlify, Vercel functions) are **not** suitable: they cannot keep the database or uploads between requests.

## Option A: a small VPS (recommended for a school)

```bash
# Ubuntu 24.04, 1 vCPU / 1 GB RAM is enough for a school
sudo apt install -y nodejs npm caddy        # use Node 22 LTS (e.g. from NodeSource)
git clone <repo> /opt/quickgrade && cd /opt/quickgrade
npm ci && npm run build
cp .env.example .env    # set NODE_ENV=production, APP_URL=https://grade.example.ph, TRUST_PROXY=true, SMTP_*, optionally ANTHROPIC_API_KEY
```

systemd unit `/etc/systemd/system/quickgrade.service`:

```ini
[Unit]
Description=QuickGrade
After=network.target

[Service]
WorkingDirectory=/opt/quickgrade
EnvironmentFile=/opt/quickgrade/.env
ExecStart=/usr/bin/node dist/server/index.mjs
Restart=always
User=quickgrade
# Keep DATA_DIR on a disk that is backed up.

[Install]
WantedBy=multi-user.target
```

Caddy (automatic HTTPS) `/etc/caddy/Caddyfile`:

```
grade.example.ph {
  request_body max_size 20MB
  reverse_proxy 127.0.0.1:3000
}
```

## Option B: Docker

```bash
docker build -t quickgrade .
docker run -d --name quickgrade -p 127.0.0.1:3000:3000 \
  -v quickgrade-data:/data --env-file .env -e TRUST_PROXY=true quickgrade
```

Put a TLS-terminating proxy (Caddy, nginx, Traefik) in front. The image runs as a non-root user, stores everything in `/data`, and has a health check on `/api/health`. *(The Dockerfile was not built in the development environment because no Docker daemon was available.)*

## Option C: Render / Railway / Fly.io

- Build command `npm ci && npm run build`; start command `node dist/server/index.mjs`.
- Attach a **persistent volume** and set `DATA_DIR` to its mount path (e.g. `/data`).
- Set `NODE_ENV=production`, `HOST=0.0.0.0`, `PORT` (platform-provided), `APP_URL`, `TRUST_PROXY=true`, and your secrets in the platform's secret manager.
- Run **one** instance (SQLite is single-writer).

## Configuration checklist

- `NODE_ENV=production` (enables Secure cookies) and HTTPS in front.
- `APP_URL` set to the public URL (used in reset emails).
- SMTP configured, so teachers can reset passwords.
- `TRUST_PROXY=true` behind a proxy (correct client IPs for rate limiting).
- Back up `DATA_DIR`.

## Backups and recovery

- Online, consistent database backup: `node dist/server/cli.mjs backup /backups/quickgrade-$(date +%F).db`. Schedule it daily with cron and copy it off-site.
- Also back up `DATA_DIR/uploads` if you keep scan photos (they are deleted automatically after the retention period).
- **Restore:** stop the service, replace `quickgrade.db` (delete any `-wal`/`-shm` files), restore `uploads/`, start.
- Migrations run automatically on start; `node dist/server/cli.mjs migrate` runs them explicitly.
- Retention cleanup runs every 6 hours, or manually with `node dist/server/cli.mjs retention`.

## Upgrading

`git pull && npm ci && npm run build && sudo systemctl restart quickgrade`. Take a backup first; migrations are forward-only.

## Scaling beyond one server

Swap SQLite for Postgres (the SQL is standard apart from a few `strftime`/`json_valid` uses) and `ScanStorage` for S3-compatible storage. Then run several instances behind a load balancer.
