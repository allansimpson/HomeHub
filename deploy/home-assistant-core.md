# Home Assistant Core — install layout, service, and upgrades (Ubuntu)

Home Assistant is **not part of HomeHub**. It runs independently; HomeHub is only an HTTP client of
it (`HomeAssistant:BaseUrl` + `HomeAssistant:Token`, see `HomeAssistantClient`). This document
records how *this* HA instance is installed so upgrades are repeatable — with a venv install they
are manual every time.

Two HomeHub features depend on this instance: **climate** (Stage 6) and **Huckleberry / baby**
(Stage H2). A broken HA upgrade degrades both, so verify climate after any core upgrade.

## Layout

Installed as **HA Core in a Python venv** (following the atlantic.net Ubuntu 24.04 guide),
*not* HA OS, Container, or Supervised.

| | |
|---|---|
| Service user | `homeassistant` |
| venv | `/srv/homeassistant` |
| Config directory | `/home/homeassistant/.homeassistant` |
| Python | **3.14.2**, installed and managed by `uv` |
| Binds | `0.0.0.0:8123` and `[::]:8123` (LAN-reachable) |
| Process management | systemd — `home-assistant.service` |

The config directory is entirely separate from the venv. **Rebuilding the venv never touches your
entities, history, or integrations.**

## systemd service

Originally the guide ran `hass` inside a detached tmux session. That survived SSH disconnects but
**not reboots**, and never restarted on a crash — unacceptable for something the wall panel depends
on. Replaced with `/etc/systemd/system/home-assistant.service`:

```ini
[Unit]
Description=Home Assistant Core
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=homeassistant
WorkingDirectory=/home/homeassistant/.homeassistant
ExecStart=/srv/homeassistant/bin/hass -c "/home/homeassistant/.homeassistant"
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now home-assistant
systemctl status home-assistant --no-pager
```

## Upgrading

> **The Python trap — read this first.** HA raises its minimum Python version periodically, and pip
> will **not** tell you loudly. When HA required ≥ 3.14.2 and the venv was on 3.13,
> `pip install --upgrade homeassistant` reported *"Requirement already satisfied (2026.2.3)"* — pip
> was correctly filtering releases it couldn't run. It looks like "already up to date." Always
> confirm the version actually moved.

**1. Check the target release's Python requirement** before doing anything:

```bash
curl -s https://pypi.org/pypi/homeassistant/json | python3 -c "import sys,json; i=json.load(sys.stdin)['info']; print(i['version'], i['requires_python'])"
```

**2. Back up the config directory** (holds `.storage/` — the entity and integration registry). Stop
HA first so the snapshot is consistent:

```bash
sudo systemctl stop home-assistant
sudo tar czf /var/backups/ha-config-$(date +%F).tar.gz -C /home/homeassistant .homeassistant
```

**3a. If the Python requirement is satisfied** — upgrade in place:

```bash
sudo -u homeassistant -H /srv/homeassistant/bin/pip install --upgrade homeassistant
sudo -u homeassistant -H /srv/homeassistant/bin/hass --version   # confirm it actually moved
```

**3b. If Python is too old** — rebuild the venv on a newer Python via `uv` (HA ships `uv`, so no
PPA and no compiling). Replace `3.14` with the needed version:

```bash
sudo -u homeassistant -H /srv/homeassistant/bin/uv python install 3.14
sudo mv /srv/homeassistant /srv/homeassistant.old
sudo install -d -o homeassistant -g homeassistant /srv/homeassistant
sudo -u homeassistant -H /srv/homeassistant.old/bin/uv venv --python 3.14 --seed /srv/homeassistant
sudo -u homeassistant -H /srv/homeassistant.old/bin/uv pip install --python /srv/homeassistant/bin/python homeassistant
sudo -u homeassistant -H /srv/homeassistant/bin/hass --version
```

Keep `/srv/homeassistant.old` until the new venv is proven — rollback is renaming it back. Remove it
afterwards.

**4. Start and expect a slow first boot.** HA Core installs each integration's Python dependencies
**lazily at runtime**, so a freshly rebuilt venv re-fetches all of them on first start. This
produces a burst of transient `ModuleNotFoundError` / `Setup failed for …` errors that resolve
themselves. Wait for the installs to finish, then restart once so everything loads with its
dependencies present:

```bash
sudo systemctl start home-assistant
pgrep -af "uv pip install"        # empty = dependency installs finished
sudo systemctl restart home-assistant
```

**5. Verify.** Scope logs to the *current* process — otherwise you will read stale errors from the
previous instance and chase ghosts:

```bash
journalctl _PID=$(systemctl show -p MainPID --value home-assistant) --no-pager | grep -i ERROR | head -20
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8123     # expect 200
```

Then verify HomeHub's dependency on it: `GET /api/climate/zones` should return live zones, not the
simulated set.

## Known issues on this install

- **`aioesphomeapi` is not auto-installed.** HA's `usb` component imports
  `serialx.platforms.serial_esphome` → `aioesphomeapi`, but that package isn't declared in the
  integration's requirements, so a rebuilt venv fails `usb` → `bluetooth` → `default_config`. Fix:
  ```bash
  sudo -u homeassistant -H /srv/homeassistant/bin/uv pip install --python /srv/homeassistant/bin/python aioesphomeapi
  ```
  **Re-apply this after any venv rebuild.**
- **Bluetooth adapter auto-recovery is disabled** — `habluetooth` warns about missing
  `NET_ADMIN`/`NET_RAW`. Harmless here: the Stage S1 design puts BLE on an ESP32 proxy reached over
  WiFi, so HA needs no local Bluetooth adapter. If a USB BT dongle is ever used directly, add
  `AmbientCapabilities=CAP_NET_ADMIN CAP_NET_RAW` to the service unit.
- **`linkplay` errors for `192.168.5.205`** — an offline WiFi speaker, pre-existing, unrelated to
  HomeHub.
- Unrelated: `minecraft.service` on this host uses the deprecated `KillMode=none` and will need
  updating eventually.

## HACS

HACS is a separate install and is required for the Huckleberry integration. It lives in the config
directory as a custom component:

```bash
sudo -u homeassistant -H mkdir -p /home/homeassistant/.homeassistant/custom_components/hacs
sudo -u homeassistant -H wget -O /tmp/hacs.zip https://github.com/hacs/integration/releases/latest/download/hacs.zip
sudo -u homeassistant -H /srv/homeassistant/bin/python -c "import zipfile; zipfile.ZipFile('/tmp/hacs.zip').extractall('/home/homeassistant/.homeassistant/custom_components/hacs')"
sudo systemctl restart home-assistant
```

Then **Settings → Devices & Services → + Add Integration → HACS**, and authorize via GitHub device
flow. `We found a custom integration hacs which has not been tested…` is the expected success log
line, not an error.

Installed via HACS as a **custom repository** (`Woyken/huckleberry-homeassistant`, type
*Integration*): **huckleberry-homeassistant v0.4.3**, pinned. Read its `MIGRATION.md` before any
upgrade — v0.4.0 renamed services, entities, and state values.

## Tokens

HomeHub authenticates with a **long-lived access token**: HA profile → Security → Long-lived access
tokens. HA shows it once. It goes in HomeHub's `HomeAssistant:Token` (user-secrets in dev, env var
in prod) and is never committed. It must grant **service-call** permission, not just reads — a
non-admin HA user will read fine and fail writes (Gate H0.4).

Huckleberry's own credentials live **only** in HA's config flow. HomeHub never holds them.
