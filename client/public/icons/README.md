# HomeHub — Icon Pack

Every file here is cut from the supplied artwork — `build/source-artwork.png`, the Art Deco keystone with the rising-sun fan. Nothing is redrawn.

## How it was built

1. The background is keyed out by luminance, leaving the brass mark on transparency with its metallic gradient intact → `png/mark.png` (817 × 965, the master).
2. Each output composites that master onto an ink `#141210` plate at the padding its platform expects, downscaled in halving steps so the fine rays stay crisp.

| Use | Mark height |
|---|---|
| App icon (`any`) | 76% of canvas |
| Maskable / monochrome | 60% — the whole mark clears Android's 80% safe circle |
| Apple touch icon | 66% (iOS adds its own corner mask) |
| Favicon | 84%, on an ink plate with 19% corner radius |

Brass reads `#C8A877` average; plate is ink `#141210` — the manifest theme and background colour.

## Files

```
manifest.webmanifest      Chrome / Android — Add to Home screen
browserconfig.xml         Windows tiles
head-snippet.html         paste-in <head> tags
favicon.ico               16 / 32 / 48 multi-resolution

svg/favicon.svg           scalable favicon (the artwork, embedded)

png/mark.png              master — mark on transparency, full resolution
png/icon-{48,72,96,128,144,192,256,384,512,1024}.png
png/icon-maskable-{192,512,1024}.png
png/icon-monochrome-{192,512}.png     white on transparent, Android themed icons
png/apple-touch-icon.png (180) + -152, -167
png/favicon-{16,32,48,96}.png
png/mstile-150.png        transparent, for Windows tiles
png/og-image.png          1200 × 630 link preview

build/source-artwork.png  the artwork as supplied
build/mark-cutout.png     keyed master (same as png/mark.png)
```

## Installing

Serve the folder at `/icons/` and paste `head-snippet.html` into `<head>`. That covers Chrome on Android (manifest + maskable + monochrome), iOS home screen, desktop tabs, Windows tiles and link previews.

Chrome's **Add to Home screen** reads `icon-maskable-192/512`, crops them to whatever shape the launcher uses — circle, squircle, teardrop — and tints `icon-monochrome-*` for people running themed icons. All three purposes are declared, so nothing is cropped badly and no white plate is inserted behind the mark.

## Two notes

- **Safari pinned tabs** need a single-colour vector, which this artwork isn't. No `mask-icon` is declared, so Safari falls back to the favicon — correct behaviour, just not a silhouette.
- **16 px** is below what an outlined mark can hold; `favicon-16.png` is a faithful downscale of the artwork and reads as a brass keystone rather than a legible fan. If the tab strip ever needs to be sharper, the fix is a simplified 16 px drawing, not a smaller scale of this one.

---

## Integration notes (added when the pack was wired in)

The pack is served from `client/public/icons/`, which `npm run build` copies verbatim into
`src/HomeHub.Api/wwwroot/`. The tags live in `client/index.html` rather than in
`head-snippet.html`, which is not shipped — it was the instruction, and it has been followed.

Four things differ from the pack as delivered, all deliberate:

1. **`svg/favicon.svg` is not linked.** Its `<image>` element carries no `href`, so it draws
   nothing — and a browser prefers a declared SVG over every PNG beside it, which would leave the
   tab blank. The file is kept for provenance. Replacing it with a real single-colour vector would
   also earn Safari a pinned-tab mask, which this raster artwork cannot provide.
2. **`theme_color` is `#15171A`, not `#141210`.** That property paints the browser chrome and the
   Android status bar, which on a standalone panel sits directly above the app; matching
   `--bg-screen` is what makes the band disappear. `background_color` stays on the icon plate
   (`#141210`) so the launch splash reads as one piece with the mark on it, and `index.html`'s
   `theme-color` meta carries the same value so the two cannot disagree.
3. **`name` / `short_name` are "HomeHub".** This is what an installed home-screen icon is labelled,
   and it cannot be edited on the device: Chrome takes the label from the manifest for a real PWA
   install, unlike a plain bookmark shortcut. Changing it here is the only way to change it, and it
   only takes effect after a rebuild, a redeploy, and removing and re-adding the icon on the phone.
   `index.html` carries the same string in `<title>`, `apple-mobile-web-app-title` and `og:title` so
   the four cannot disagree.
4. **The masters were not copied.** `build/` is 2.3 MB of source artwork, and `png/mark.png` was
   byte-identical to `build/mark-cutout.png` — neither has a reason to sit behind a public URL, and
   everything under `client/public/` is served. Both stay in the original delivery. The `-1024`
   outputs were kept: they are finished icons at a size a store listing may ask for, not sources.

`display_override` may be flagged by an editor's JSON schema. It is a standard App Manifest member
and is correct as written.
