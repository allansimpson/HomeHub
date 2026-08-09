# Local development over HTTPS

Development normally runs over plain HTTP and that is fine for everything except one screen: the
phone-side barcode scanner (`/pantry/scan`, PANTRY_SCREEN §3).

Browsers expose `navigator.mediaDevices.getUserMedia` **only in a secure context** — HTTPS, or
`localhost`. A phone reaching the dev machine at `http://192.168.5.213:5173` is neither, so the
camera is not blocked but *absent*: `navigator.mediaDevices` is `undefined`. The scan screen detects
this and says `NEEDS HTTPS FOR THE CAMERA`, falling back to `TYPE ONE`.

This document sets up a local certificate authority so that phone gets a real, warning-free HTTPS
origin.

---

## 1 · Generate the certificates

From the repo root, in Git Bash:

```bash
bash scripts/make-dev-certs.sh
```

It writes three files into `certs/` (gitignored):

| File | What it is |
|---|---|
| `homehub-dev-ca.crt` | The local CA. **This is the one you install on devices.** |
| `homehub-dev.crt` | The server certificate, signed by that CA. |
| `homehub-dev.key` | Its private key. |

The script detects every IPv4 address on the machine and puts all of them in the certificate's
Subject Alternative Name, along with `localhost` and the machine's hostname. Pass addresses
explicitly to override:

```bash
bash scripts/make-dev-certs.sh 192.168.5.213
```

**Re-run it whenever the machine's LAN address changes.** The CA is reused, so devices stay trusted;
only the server certificate is re-issued.

### Why a CA rather than a plain self-signed certificate

Phones install *CA* certificates, not leaf certificates, and iOS additionally requires the CA to be
switched on afterwards (§3). Issuing one CA and signing leaves from it means each device is set up
once, and every later re-issue is trusted automatically.

Clicking through a browser warning is **not** an alternative: it is per-origin, it resets, and on
iOS it does not reliably grant a secure context — which is the entire point of the exercise.

---

## 2 · Trust the CA on the dev machine

```powershell
Import-Certificate -FilePath .\certs\homehub-dev-ca.crt -CertStoreLocation Cert:\CurrentUser\Root
```

Windows will ask for confirmation because this installs a root authority. That is the correct
prompt to see — say yes only because you just generated this CA yourself, on this machine.

To undo it later, delete the "HomeHub Dev CA" entry from `certmgr.msc` → Trusted Root Certification
Authorities.

---

## 3 · Trust the CA on a phone or tablet

Get `certs/homehub-dev-ca.crt` onto the device. The least painful route is to let the app hand it
over itself: `make-dev-certs.sh` drops a copy into `client/public/` (gitignored), so it is served
at a fixed path by the dev server and by every deployed release alike:

```
https://<dev-machine-ip>:5173/homehub-dev-ca.crt     # from dev
http://<server>:5000/homehub-dev-ca.crt              # from the deployed panel (your HTTP port)
```

The download from dev shows a certificate warning, since the phone does not trust the CA yet —
that is expected and harmless: the file is public by design, and nothing sensitive crosses. (The
panel URL uses plain HTTP for the same reason.)

**The copy stays in `client/public/`, deliberately.** `npm run build` ships it into the panel's
web root, which is what lets a new phone be set up from the panel with no dev machine involved
(see `server-systemd.md` D6). Publishing it is safe: trust comes from the CA *key*, which never
leaves `certs/`. The copy is gitignored, so each household serves its own CA and nobody's ends up
in the repo. If you regenerate the CA, re-run the script — it refreshes the copy.

**Android**
1. Settings → search "CA certificate" (the menu path moves between versions; on recent Pixels it is
   Security & privacy → More security & privacy → Encryption & credentials → Install a certificate).
2. Choose **CA certificate**, accept the "your data won't be private" warning, pick the downloaded
   file.
3. It appears under "User credentials". Chrome picks it up immediately — no restart needed.

**iOS / iPadOS** — two steps, and the second is the one everybody misses:
1. Open the `.crt`; iOS offers to download a *profile*. Then
   Settings → General → VPN & Device Management → install it.
2. **Settings → General → About → Certificate Trust Settings → enable full trust for
   "HomeHub Dev CA".** Without this the certificate is installed but not trusted, and Safari still
   refuses the origin with no useful message.

---

## 4 · Run it

Nothing to configure. Both servers detect the certificate by its presence:

- **Kestrel** ([Program.cs](../src/HomeHub.Api/Program.cs)) binds `http://*:5220` **and**
  `https://*:7288` when `certs/homehub-dev.crt` exists and the environment is Development.
- **Vite** ([vite.config.ts](../client/vite.config.ts)) serves HTTPS on 5173 and points its `/api`
  proxy at `https://localhost:7288`.

A checkout with no `certs/` folder behaves exactly as it always did — plain HTTP, no setup needed.

```
https://<dev-machine-ip>:5173/          the panel
https://<dev-machine-ip>:5173/pantry/scan   the scanner
https://<dev-machine-ip>:7288/api/pantry    the API directly
```

---

## 5 · What this does and does not fix

HTTPS gets you the secure context, and therefore the camera. It does **not** get you a barcode
decoder.

`BarcodeDetector` — the API the scan screen uses to read UPC/EAN symbologies — is Chromium-only:

| Platform | Camera (needs HTTPS) | `BarcodeDetector` | Scanning works? |
|---|---|---|---|
| Android · Chrome / Edge | yes | yes | **yes** |
| Windows desktop · Chrome | yes | **no** | no — reads `THIS BROWSER CAN'T READ BARCODES` |
| iOS · any browser | yes | **no** | no — every iOS browser is WebKit underneath |

Making it work on iPhones means replacing `BarcodeDetector` with a WASM decoder (`zxing-wasm` or
`@zxing/library`), which decodes in JavaScript and works anywhere `getUserMedia` does. The rest of
the screen is unaffected: `Barcodes.Normalise` already takes the reported symbology as an optional
argument, and the run list, idempotency and `NAME IT` paths are decoder-agnostic.

---

## 6 · Production

**The deployed panel now does the same thing**, which it did not when this document was written.
`Program.cs` binds HTTP always and adds HTTPS whenever a certificate is present, in production as
well as development — production reading its pair from `Server:CertPath` / `Server:KeyPath` rather
than the fixed dev path. No certificate is ever *generated* on the server; it is signed here and
uploaded.

Give the panel its own certificate from this same CA, so the phones set up above need nothing
further:

```bash
bash scripts/make-panel-cert.sh <panel-host> <panel-ip>
bash scripts/deploy.sh --certs
```

See [`server-systemd.md` → Part D](server-systemd.md#part-d--https-for-the-panel), which is a required
part of deploying the panel rather than an optional extra.
