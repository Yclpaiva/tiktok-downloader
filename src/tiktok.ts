// Reads TikTok's own hydration data for an item. Every item page embeds a
// `__UNIVERSAL_DATA_FOR_REHYDRATION__` script with the full item struct:
// video URLs, slideshow images, author and music. The media CDN only serves
// requests carrying the browser session (cookies), so the fetch itself happens
// in the page context.

export type MediaFile = { url: string; filename: string };

/** /@user/video/<id> or /@user/photo/<id>; the id is unique, the user is cosmetic. */
const ITEM_RE = /\/@([\w.]+)\/(?:video|photo)\/(\d+)/;
const DATA_TAG_RE =
  /<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application\/json">(.*?)<\/script>/s;

export type ItemRef = { user: string; id: string };

export function itemIn(text: string): ItemRef | null {
  const match = ITEM_RE.exec(text);
  return match?.[1] && match?.[2] ? { user: match[1], id: match[2] } : null;
}

export const itemUrl = (ref: ItemRef) => `https://www.tiktok.com/@${ref.user}/video/${ref.id}`;

type UrlList = { urlList?: string[] };

export type ItemStruct = {
  id?: string;
  author?: { uniqueId?: string };
  video?: {
    playAddr?: string;
    downloadAddr?: string;
    bitrateInfo?: { PlayAddr?: UrlList & { Bitrate?: number } }[];
  };
  imagePostData?: { images?: { imageURL?: UrlList }[] };
};

type HydrationData = {
  __DEFAULT_SCOPE__?: {
    "webapp.video-detail"?: { itemInfo?: { itemStruct?: ItemStruct } };
  };
};

/** Pulls the item struct out of the hydration JSON itself (a script tag's textContent). */
export function parseItemData(json: string): ItemStruct {
  let data: HydrationData;
  try {
    data = JSON.parse(json) as HydrationData;
  } catch {
    throw new Error("Dados do item em formato inesperado (layout mudou?)");
  }
  const item = data.__DEFAULT_SCOPE__?.["webapp.video-detail"]?.itemInfo?.itemStruct;
  if (!item) throw new Error("Item não encontrado (privado ou removido?)");
  return item;
}

/** Pulls the item struct out of an item page's HTML (live DOM or fetched). */
export function parseItemPage(html: string): ItemStruct {
  const json = DATA_TAG_RE.exec(html)?.[1];
  if (!json) throw new Error("Página do TikTok sem os dados do item (layout mudou?)");
  return parseItemData(json);
}

const firstUrl = (list: UrlList | undefined) => list?.urlList?.[0];

const extensionOf = (url: string) => {
  const ext = new URL(url).pathname.split(".").pop() ?? "";
  return /^[a-z0-9]{2,5}$/i.test(ext) ? ext : "bin";
};

/** Best video URL: TikTok's own download link, then the player's, then the highest bitrate. */
export function videoUrlFrom(item: ItemStruct): string | null {
  if (item.video?.downloadAddr) return item.video.downloadAddr;
  if (item.video?.playAddr) return item.video.playAddr;
  const best = [...(item.video?.bitrateInfo ?? [])].sort(
    (a, b) => (b.PlayAddr?.Bitrate ?? 0) - (a.PlayAddr?.Bitrate ?? 0),
  )[0];
  return firstUrl(best?.PlayAddr) ?? null;
}

/**
 * Flattens an item into downloadable files: the video, or every image of a
 * slideshow in order.
 */
export function filesFromItem(item: ItemStruct): MediaFile[] {
  const base = `${item.author?.uniqueId ?? "tiktok"}_${item.id ?? "unknown"}`;
  const images = item.imagePostData?.images ?? [];
  if (images.length) {
    return images.flatMap((image, i) => {
      const url = firstUrl(image.imageURL);
      const stem = images.length > 1 ? `${base}_${i + 1}` : base;
      return url ? [{ url, filename: `${stem}.${extensionOf(url)}` }] : [];
    });
  }
  const url = videoUrlFrom(item);
  return url ? [{ url, filename: `${base}.${extensionOf(url)}` }] : [];
}
