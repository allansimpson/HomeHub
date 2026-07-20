# Server deployment — systemd service (Ubuntu)

The app is one deployable unit: the ASP.NET Core API serves the built React SPA from
`wwwroot`. It runs as a **systemd** service with `Restart=always`. Kestrel is served
directly on the LAN over HTTP (nginx/TLS can be layered in front later).

> The Ubuntu server and SQL Server instance already exist. This document does **not**
> provision the OS or the database engine — only the app service.

## 1. Build & publish (on the build machine or the server)

```bash
# a) Build the React SPA into the API's wwwroot
cd client
npm ci
npm run build            # outputs to ../src/HomeHub.Api/wwwroot

# b) Publish the API (self-contained folder). Requires the .NET 10 SDK.
cd ../src/HomeHub.Api
dotnet publish -c Release -o /opt/homehub
```

Copy `/opt/homehub` to the server if you built elsewhere. The published folder already
contains the SPA (wwwroot) and the fonts.

## 2. Secrets (never committed)

The SQL connection string is provided to the service via an environment variable, read by
`ConnectionStrings__HomeHub`. Store it in a root-only env file:

```bash
sudo install -m 600 /dev/null /etc/homehub/homehub.env
sudo tee /etc/homehub/homehub.env >/dev/null <<'EOF'
ConnectionStrings__HomeHub=Server=localhost;Database=HomeHub;User Id=homehub_app;Password=REPLACE_ME;TrustServerCertificate=True
ASPNETCORE_ENVIRONMENT=Production
ASPNETCORE_URLS=http://0.0.0.0:5000
# RunMigrationsOnStartup=true   # default; set false to apply migrations manually
EOF
```

- Use a **least-privilege SQL login** scoped to the `HomeHub` database (the app owns and
  migrates only its own database; it must not touch anything else on the instance).
- On first start the app applies EF Core migrations and creates the `HomeHub` database.

## 3. systemd unit

`/etc/systemd/system/homehub.service`:

```ini
[Unit]
Description=Central Home App (HomeHub.Api)
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
WorkingDirectory=/opt/homehub
ExecStart=/usr/bin/dotnet /opt/homehub/HomeHub.Api.dll
EnvironmentFile=/etc/homehub/homehub.env
Restart=always
RestartSec=3
User=homehub
Group=homehub
# Hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/homehub

[Install]
WantedBy=multi-user.target
```

```bash
sudo useradd --system --no-create-home homehub 2>/dev/null || true
sudo chown -R homehub:homehub /opt/homehub
sudo systemctl daemon-reload
sudo systemctl enable --now homehub
sudo systemctl status homehub
```

## 4. Verify

```bash
curl -s http://<server-lan-ip>:5000/api/health      # {"status":"ok",...}
curl -sI http://<server-lan-ip>:5000/               # 200, serves the SPA
# Kill test — service should relaunch within RestartSec:
sudo systemctl kill homehub && sleep 5 && systemctl is-active homehub
```

## Manual migrations (optional, if RunMigrationsOnStartup=false)

```bash
cd src/HomeHub.Api
ConnectionStrings__HomeHub='...' dotnet ef database update
```

## Optional: nginx reverse proxy (later)

Front Kestrel with nginx for a clean URL / TLS on the LAN. Proxy `/` → `http://127.0.0.1:5000`
with `proxy_http_version 1.1` and the `Upgrade`/`Connection` headers set (SignalR WebSockets
are used from later stages). Not required for Stage 0.
