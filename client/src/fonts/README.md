# Self-hosted fonts

These are shipped with the app so the kiosk never depends on a CDN at boot.

| File | Family / weight | Used for |
|---|---|---|
| `Marcellus-Regular.woff2` | Marcellus 400 | numerals, clocks, temperatures, month names, screen titles |
| `JosefinSans-Light.woff2` | Josefin Sans 300 | body text |
| `JosefinSans-Regular.woff2` | Josefin Sans 400 | labels |
| `JosefinSans-SemiBold.woff2` | Josefin Sans 600 | alert titles |

Both families are licensed under the **SIL Open Font License 1.1** (free to self-host and
redistribute with the app). Source: Google Fonts. Subset: latin (sufficient for current
copy — re-fetch a wider subset if non-latin copy is added).

Declared via `@font-face` in `fonts.css` with `font-display: block`.
