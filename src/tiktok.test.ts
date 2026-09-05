import { describe, expect, test } from "bun:test";
import { filesFromItem, itemIn, itemUrl, parseItemData, parseItemPage, videoUrlFrom } from "./tiktok";

const page = (item: unknown) =>
  `<html><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify({
    __DEFAULT_SCOPE__: { "webapp.video-detail": { itemInfo: { itemStruct: item } } },
  })}</script></html>`;

const videoItem = (over: Record<string, unknown> = {}) => ({
  id: "7106594312292453675",
  author: { uniqueId: "tiktok" },
  video: {
    playAddr: "https://cdn/play.mp4",
    downloadAddr: "https://cdn/download.mp4",
    bitrateInfo: [
      { PlayAddr: { Bitrate: 640712, urlList: ["https://cdn/low.mp4"] } },
      { PlayAddr: { Bitrate: 1094429, urlList: ["https://cdn/high.mp4"] } },
    ],
  },
  ...over,
});

describe("itemIn", () => {
  test("reads video and photo refs from hrefs and paths", () => {
    expect(itemIn("/@tiktok/video/7106594312292453675?is_from_webapp=1")).toEqual({
      user: "tiktok",
      id: "7106594312292453675",
    });
    expect(itemIn("https://www.tiktok.com/@ NASA/photo/123")).toBeNull();
    expect(itemIn("/@user.name/photo/1234567890123456789")).toEqual({
      user: "user.name",
      id: "1234567890123456789",
    });
  });

  test("rejects non-item paths", () => {
    expect(itemIn("/foryou")).toBeNull();
    expect(itemIn("/@tiktok/live")).toBeNull();
    expect(itemIn("/@tiktok/video/abc")).toBeNull();
  });

  test("itemUrl round-trips", () => {
    const ref = itemIn("/@a.b/video/123")!;
    expect(itemUrl(ref)).toBe("https://www.tiktok.com/@a.b/video/123");
  });
});

describe("parseItemPage", () => {
  test("extracts the item struct from a real page shape", () => {
    const item = parseItemPage(page(videoItem()));
    expect(item.author?.uniqueId).toBe("tiktok");
    expect(item.video?.downloadAddr).toBe("https://cdn/download.mp4");
  });

  test("rejects pages without hydration data", () => {
    expect(() => parseItemPage("<html></html>")).toThrow(/sem os dados/);
  });

  test("rejects pages without the item", () => {
    const noItem = `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify(
      { __DEFAULT_SCOPE__: { "webapp.video-detail": {} } },
    )}</script>`;
    expect(() => parseItemPage(noItem)).toThrow(/não encontrado/);
  });
});

describe("parseItemData", () => {
  test("parses the raw JSON of a script tag's textContent", () => {
    const item = parseItemData(JSON.stringify({
      __DEFAULT_SCOPE__: { "webapp.video-detail": { itemInfo: { itemStruct: videoItem() } } },
    }));
    expect(item.video?.downloadAddr).toBe("https://cdn/download.mp4");
  });

  test("rejects non-JSON content", () => {
    expect(() => parseItemData("<html></html>")).toThrow(/inesperado/);
  });
});

describe("videoUrlFrom", () => {
  test("prefers downloadAddr over playAddr", () => {
    expect(videoUrlFrom(videoItem())).toBe("https://cdn/download.mp4");
  });

  test("falls back to the highest bitrate rendition", () => {
    const item = videoItem({ video: { bitrateInfo: videoItem().video.bitrateInfo } });
    expect(videoUrlFrom(item)).toBe("https://cdn/high.mp4");
  });

  test("returns null when there is no video", () => {
    expect(videoUrlFrom({})).toBeNull();
  });
});

describe("filesFromItem", () => {
  test("returns one video file named after author and id", () => {
    expect(filesFromItem(videoItem())).toEqual([
      { url: "https://cdn/download.mp4", filename: "tiktok_7106594312292453675.mp4" },
    ]);
  });

  test("numbers slideshow images in order", () => {
    const item = videoItem({
      imagePostData: {
        images: [
          { imageURL: { urlList: ["https://cdn/a.jpeg", "https://cdn/a-small.jpeg"] } },
          { imageURL: { urlList: ["https://cdn/b.jpeg"] } },
        ],
      },
    });
    expect(filesFromItem(item)).toEqual([
      { url: "https://cdn/a.jpeg", filename: "tiktok_7106594312292453675_1.jpeg" },
      { url: "https://cdn/b.jpeg", filename: "tiktok_7106594312292453675_2.jpeg" },
    ]);
  });

  test("keeps the real extension and falls back to bin", () => {
    const item = videoItem({ video: { playAddr: "https://cdn/video" } });
    expect(filesFromItem(item)[0]?.filename).toBe("tiktok_7106594312292453675.bin");
  });

  test("returns empty for an item without media", () => {
    expect(filesFromItem({ id: "1", author: { uniqueId: "x" } })).toEqual([]);
  });
});
