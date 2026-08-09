# Pi kiosk setup — Raspberry Pi 5, 4K portrait touch panel

The Pi holds **no app logic** — it is glass. It auto-logs-in, launches Chromium full-screen
at the server URL, and self-heals on crash/reboot. If the server is unreachable at boot it
shows a calm retry state, not a browser error.

Target: **2160×3840 portrait**, `devicePixelRatio 1`. Set `SERVER_URL` to the server's LAN
address, e.g. `http://192.168.1.10:5000`.

## 1. Display — portrait orientation

On Pi OS (Wayland/labwc, the Pi 5 default) set the panel to portrait. Using `wlr-randr`
(find the output name with `wlr-randr` first):

```bash
wlr-randr --output HDMI-A-1 --transform 90 --mode 3840x2160
```

Persist it in the compositor autostart (see below) so it applies every boot. Disable screen
blanking / DPMS so the wall panel never sleeps.

## 2. Auto-login to a graphical session

```bash
sudo raspi-config    # System Options -> Boot / Auto Login -> Desktop Autologin
```

## 3. Kiosk launch script

`/home/pi/kiosk.sh` (chmod +x):

```bash
#!/usr/bin/env bash
set -u
SERVER_URL="http://192.168.1.10:5000"

# Prevent the panel from blanking.
wlr-randr --output HDMI-A-1 --transform 90 --mode 3840x2160 || true
swayidle -w timeout 0 '' || true    # or: xset s off -dpms  (X11)

# Wait for the server to answer before opening Chromium — calm retry, no error page.
until curl -sf "$SERVER_URL/api/health" >/dev/null 2>&1; do
  echo "waiting for $SERVER_URL ..."
  sleep 2
done

exec chromium-browser \
  --kiosk "$SERVER_URL" \
  --start-fullscreen \
  --noerrdialogs \
  --disable-infobars \
  --disable-session-crashed-bubble \
  --disable-features=Translate,TranslateUI,OverscrollHistoryNavigation \
  --overscroll-history-navigation=0 \
  --disable-pinch \
  --check-for-update-interval=31536000 \
  --incognito \
  --password-store=basic
```

> On Pi OS the binary may be `chromium` rather than `chromium-browser` — adjust to match.
> The `until curl … /api/health` loop is the "calm retry": Chromium only opens once the
> server is reachable, so the panel never shows a connection-error page at boot.

## 4. Self-healing launcher (systemd user service, Restart=always)

`~/.config/systemd/user/homehub-kiosk.service`:

```ini
[Unit]
Description=Central Home kiosk (Chromium)
After=graphical-session.target
PartOf=graphical-session.target

[Service]
Type=simple
ExecStart=/home/pi/kiosk.sh
Restart=always
RestartSec=3

[Install]
WantedBy=graphical-session.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now homehub-kiosk
loginctl enable-linger pi     # keep the user service running across the session
```

(If the session is X11/autostart instead of a user systemd unit, put a `while true; do
/home/pi/kiosk.sh; sleep 2; done` loop in `~/.config/lxsession/LXDE-pi/autostart` or the
labwc autostart file — same self-heal effect.)

## 5. Verify (Stage 0 done criteria)

- Reboot the Pi → it comes up straight into the full-screen dashboard shell, no browser
  chrome, correct Meridian Ledger styling and self-hosted fonts, crisp hairlines at 4K.
- Kill Chromium (`pkill chromium`) → it relaunches automatically within `RestartSec`.
- Power the server off, then reboot the Pi → the panel shows the calm "waiting for server"
  state and connects automatically once the server returns (no error page).
