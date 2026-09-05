<div align="center">

# TikTok Downloader

**A download button for every TikTok — right where it lives.**

Feed · Video pages · Profile grid · Slideshows

[![Chrome](https://img.shields.io/badge/Chrome-MV3-4285F4?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/develop/concepts/manifest-v3)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Bun](https://img.shields.io/badge/Bun-built_with-fbf0c9?logo=bun&logoColor=black)](https://bun.sh)
[![License](https://img.shields.io/badge/license-private-lightgrey)](#license)

</div>

---

TikTok Downloader overlays a small button on top of TikTok videos and
thumbnails. One click saves the video straight to `Downloads/TikTok/` — no
copy-pasting links, no third-party downloader sites, no watermark apps.

The button behaves like the player's own controls: invisible until you move the
mouse over the video, gone a few seconds after you stop. Downloads appear in
Chrome's native download bubble, with progress and native errors.

## What it does

| Where | What you get |
| --- | --- |
| Feed (For You) | Button on the playing slide |
| Video & photo pages | Button on the player |
| Profile grid & search | Button on every thumbnail |
| Slideshows | Every photo, in order, in one click |

The file is the same MP4 TikTok's own web download serves — H.264 + AAC,
named after the author and the item id.

## How it works

No native host, no scraping service. The extension reads TikTok's own
hydration data — the `__UNIVERSAL_DATA_FOR_REHYDRATION__` JSON that every item
page embeds — which carries the media URLs, author and id. The media CDN only
serves requests carrying the browser session, so the download fetch happens in
the page context and is handed to `chrome.downloads.download` as a blob URL.

- On item pages the data comes from the current document.
- On feed players the item id comes from the xgplayer wrapper and the author
  from the slide's own links; the item page is loaded in a hidden same-origin
  iframe to read its data.
- On thumbnails the identifier comes from the card's link.

## Install

Requires [Bun](https://bun.sh).

```sh
bun install
bun run build    # generates dist/
```

Then in Chrome:

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select the `dist/` folder

You must be logged in to TikTok in the tab — the extension borrows that
session. After each rebuild, hit the refresh icon on the extension card and
reload the TikTok tab.

## Development

```sh
bun run build   # bundle content + background scripts into dist/
bun run check   # tsc --noEmit
bun test
```

```
src/
├── content.ts      # DOM scanning, button overlay, auto-hide, hidden iframe
├── tiktok.ts       # hydration data parsing, media URL resolution
├── background.ts   # chrome.downloads wiring
└── messages.ts     # content ⇄ background contract
```

## Limitations

- You must be logged in to TikTok in the tab.
- Downloading many items in a row can make TikTok ask for verification; the
  button turns red and tells you. Wait a moment and try again.
- Private or removed items fail with a red button and the reason in the tooltip.

## License

Personal project, published as-is. TikTok's terms apply to whatever you
download.
