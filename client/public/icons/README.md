# HomeHub — Icon Pack

Every file here is cut from the supplied artwork — `build/source-artwork.png`, the Art Deco keystone with the rising-sun fan. Nothing is redrawn.

**Rebuilt 2026-08-10** from the revised artwork: brighter hammered-foil gold, heavier strokes, stronger bevel. Same geometry, same paddings — only the finish changed. The previous cut was a softer, flatter brass.

## How it was built

1. The background is keyed out by luminance, leaving the brass mark on transparency with its metallic gradient intact → `png/mark.png` (817 × 965, the master).
2. Each output composites that master onto an ink `#141210` plate at the padding its platform expects, downscaled in halving steps so the fine rays stay crisp.

| Use | Mark height |
|---|---|
| App icon (`any`) | 76% of canvas |
| Maskable / monochrome | 60% — the whole mark clears Android's 80% safe circle |
| Apple touch icon | 66% (iOS adds its own corner mask) |
| Favicon | 84%, on an ink plate with 19% corner radius |

Brass reads `#E0B145` average (was `#C8A877` on the previous artwork); plate is ink `#141210` — the manifest theme and background colour.

The project's `/icons/` folder is generated from the same master and kept in step — it previously held an older, unrelated gabled-roof mark.

## Files

```
manifest.webmanifest      Chrome / Android — Add to Home screen
browserconfig.xml         Windows tiles
head-snippet.html         paste-in <head> tags
favicon.ico               16 / 32 / 48 multi-resolution

svg/favicon.svg           scalable favicon (vector redraw, ink plate)
svg/mark.svg              the mark alone, on transparency
svg/safari-pinned-tab.svg solid black silhouette, Safari pinned tabs

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

## One local edit, on purpose

`manifest.webmanifest` ships `"theme_color": "#141210"` — the icon plate's ink. In this repo it is
**`#15171A`**, the app's own `--bg-screen`, and `index.html` carries the same value in its
`<meta name="theme-color">` for the same reason: that colour paints the browser chrome and the
Android status bar, and on a panel running standalone that band sits directly above the app, where
matching the screen is what makes it disappear. `background_color` stays on the plate ink, so the
launch splash still reads as one piece with the mark on it.

**Re-apply that line after any rebuild from the pack**, or the status bar goes a shade off.

`build/` (3.1 MB of source artwork) and `head-snippet.html` are not committed — everything under
`public/` is served verbatim, and neither is fetched by the app. They stay in the delivered pack.

## Installing

Serve the folder at `/icons/` and paste `head-snippet.html` into `<head>`. That covers Chrome on Android (manifest + maskable + monochrome), iOS home screen, desktop tabs, Windows tiles and link previews.

Chrome's **Add to Home screen** reads `icon-maskable-192/512`, crops them to whatever shape the launcher uses — circle, squircle, teardrop — and tints `icon-monochrome-*` for people running themed icons. All three purposes are declared, so nothing is cropped badly and no white plate is inserted behind the mark.

## Two notes

- **The SVGs are a redraw, not the artwork.** The raster outputs are cut from the photograph and keep its hammered-foil texture; the SVGs are true vector paths (outline, nine rays, half-dome, base bar) fitted to that artwork at 90% pixel overlap, with a three-stop gradient standing in for the foil. Vector was necessary: an embedded raster is stripped by SVG sanitizers and would have shipped a blank plate. Scale is exact — geometry was measured off `png/mark.png`, not eyeballed.
- **16 px** is below what an outlined mark can hold; `favicon-16.png` is a faithful downscale and reads as a brass keystone rather than a legible fan. The vector favicon degrades better at that size, and modern browsers prefer it.
