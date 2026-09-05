import {
  filesFromItem, itemIn, itemUrl, parseItemData, type ItemRef, type ItemStruct, type MediaFile,
} from "./tiktok";
import type { DownloadRequest, DownloadResponse } from "./messages";

const HOST_ATTR = "data-tkdl";
const MIN_SIZE = 100;
// Same rule as the YT extension: visible while the pointer moves, gone shortly after.
const HIDE_DELAY_MS = 3000;

const hosts = new WeakMap<Element, HTMLElement>();

const ICONS = {
  idle: `<svg viewBox="0 0 24 24"><path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/></svg>`,
  loading: `<svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-6.2-8.56"/></svg>`,
  done: `<svg viewBox="0 0 24 24"><path d="m5 12 5 5L20 7"/></svg>`,
  error: `<svg viewBox="0 0 24 24"><path d="M12 7v6"/><path d="M12 17h.01"/></svg>`,
};
type State = keyof typeof ICONS;

const STYLE = `
  :host { line-height: 0; }
  button { all: unset; box-sizing: border-box; width: 32px; height: 32px; border-radius: 50%;
    background: rgba(0,0,0,.6); color: #fff; display: grid; place-items: center; cursor: pointer;
    opacity: .85; transition: opacity .15s, background .15s; backdrop-filter: blur(4px); }
  button:hover { opacity: 1; background: rgba(0,0,0,.85); }
  button[data-state="loading"] svg { animation: spin .8s linear infinite; }
  button[data-state="done"] { background: #1f8a4c; }
  button[data-state="error"] { background: #c0392b; }
  svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 2.2;
    stroke-linecap: round; stroke-linejoin: round; }
  @keyframes spin { to { transform: rotate(360deg); } }
`;

// --- context discovery -------------------------------------------------------

/**
 * Where the item id comes from: the nearest anchor in the subtree (grid and
 * search cards), the xgplayer wrapper id (feed players), or the URL itself
 * (item pages). Resolved at click time so it never goes stale.
 */
const WRAPPER_ID_RE = /^xgwrapper-\d+-(\d+)$/;
const AUTHOR_HREF_RE = /^\/@([\w.]+)/;

function refNear(media: Element): ItemRef | null {
  let wrapperId: string | null = null;
  let node: Element | null = media;
  while (node && node !== document.body) {
    for (const a of node.matches("a[href]") ? [node] : node.querySelectorAll("a[href]")) {
      const ref = itemIn(a.getAttribute("href") ?? "");
      if (ref) return ref;
    }
    if (!wrapperId) wrapperId = WRAPPER_ID_RE.exec(node.id)?.[1] ?? null;
    if (wrapperId) {
      // The slide container holds only its own author's links; broader
      // containers mix adjacent slides and are ignored.
      const authors = new Set(
        [...node.querySelectorAll('a[href^="/@"]')].map((a) => a.getAttribute("href")),
      );
      if (authors.size === 1) {
        const user = AUTHOR_HREF_RE.exec([...authors][0] ?? "")?.[1];
        if (user) return { user, id: wrapperId };
      }
    }
    node = node.parentElement;
  }
  return itemIn(location.pathname);
}

// --- item data ----------------------------------------------------------------

/** The current page's own hydration data, when it belongs to `ref`. */
function localItemHtml(ref: ItemRef): string | null {
  const here = itemIn(location.pathname);
  if (!here || here.id !== ref.id) return null;
  const tag = document.querySelector<HTMLScriptElement>("#__UNIVERSAL_DATA_FOR_REHYDRATION__");
  return tag?.textContent ?? null;
}

/**
 * Loads another item's page in a hidden same-origin iframe and reads its
 * hydration data. A plain fetch of the item URL returns TikTok's app shell
 * without data; a document navigation gets the full SSR page. The iframe may
 * pass through intermediate documents, so poll instead of trusting one load
 * event.
 */
function itemDataFromIframe(ref: ItemRef): Promise<ItemStruct> {
  return new Promise((resolve, reject) => {
    const iframe = document.createElement("iframe");
    iframe.style.cssText = "position:fixed;width:800px;height:600px;left:-9999px;top:-9999px;";
    iframe.src = itemUrl(ref);
    document.documentElement.appendChild(iframe);

    const started = Date.now();
    let lastError: Error | null = null;
    const poll = () => {
      const doc = iframe.contentDocument;
      // A challenge/login page never becomes the item page; fail fast.
      if (/login|captcha|verify/.test(doc?.location.pathname ?? "")) {
        iframe.remove();
        return reject(new Error("TikTok pediu verificação; tente de novo em instantes"));
      }
      const tag = doc?.querySelector("#__UNIVERSAL_DATA_FOR_REHYDRATION__");
      if (tag?.textContent) {
        try {
          const item = parseItemData(tag.textContent);
          iframe.remove();
          return resolve(item);
        } catch (err) {
          // While the document streams in, the JSON is partial; keep polling.
          lastError = err instanceof Error ? err : new Error(String(err));
        }
      }
      if (Date.now() - started > 20_000) {
        iframe.remove();
        return reject(
          lastError ?? new Error("TikTok não carregou os dados do item; tente de novo"),
        );
      }
      setTimeout(poll, 300);
    };
    poll();
  });
}

async function itemDataFor(ref: ItemRef): Promise<ItemStruct> {
  const local = localItemHtml(ref);
  return local ? parseItemData(local) : itemDataFromIframe(ref);
}

// --- media fetch --------------------------------------------------------------

/** Pulls the bytes with the page's session; the CDN only serves those. */
async function fetchBlob(file: MediaFile): Promise<string> {
  const res = await fetch(file.url, { credentials: "include" });
  if (!res.ok) throw new Error(`TikTok respondeu ${res.status} ao baixar a mídia`);
  return URL.createObjectURL(await res.blob());
}

async function download(file: MediaFile): Promise<void> {
  const blobUrl = await fetchBlob(file);
  try {
    const request: DownloadRequest = { type: "download", url: blobUrl, filename: file.filename };
    const response = (await chrome.runtime.sendMessage(request)) as DownloadResponse | undefined;
    if (!response?.ok) throw new Error(response?.error ?? "Falha ao iniciar o download");
  } finally {
    setTimeout(() => URL.revokeObjectURL(blobUrl), 30_000);
  }
}

// --- overlay -----------------------------------------------------------------

/**
 * The element the media visually fills. Media elements can't host children, so
 * the frame is the nearest ancestor with the same visual box; zero-size
 * wrappers (player init) are skipped during the climb.
 */
function frameFor(media: HTMLElement): HTMLElement {
  const { width, height } = media.getBoundingClientRect();
  let frame = media.parentElement ?? media;
  for (let el = frame.parentElement; el && el !== document.body; el = el.parentElement) {
    if (/^(MAIN|HEADER|FOOTER|NAV)$/.test(el.tagName)) break;
    const rect = el.getBoundingClientRect();
    if (rect.width < MIN_SIZE || rect.height < MIN_SIZE) continue;
    if (Math.abs(rect.width - width) > 4 || Math.abs(rect.height - height) > 4) break;
    frame = el as HTMLElement;
  }
  return frame;
}

/** True when a mounted button already covers most of this media's visual area. */
function coveredByHost(rect: DOMRect): boolean {
  const area = rect.width * rect.height;
  if (area <= 0) return false;
  for (const host of document.querySelectorAll<HTMLElement>(`[${HOST_ATTR}]`)) {
    const fr = host.parentElement?.getBoundingClientRect();
    if (!fr) continue;
    const overlap =
      Math.max(0, Math.min(rect.right, fr.right) - Math.max(rect.left, fr.left)) *
      Math.max(0, Math.min(rect.bottom, fr.bottom) - Math.max(rect.top, fr.top));
    if (overlap > 0.5 * area) return true;
  }
  return false;
}

function mount(frame: HTMLElement, getRef: () => ItemRef | null): HTMLElement {
  const existing = frame.querySelector<HTMLElement>(`:scope > [${HOST_ATTR}]`);
  if (existing) return existing;

  if (getComputedStyle(frame).position === "static") frame.style.position = "relative";

  const host = document.createElement("div");
  host.setAttribute(HOST_ATTR, "");
  host.style.cssText =
    "position:absolute;top:10px;right:10px;z-index:2147483647;width:32px;height:32px;" +
    "opacity:0;visibility:hidden;transition:opacity .2s,visibility .2s;";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>${STYLE}</style><button type="button"></button>`;
  const button = root.querySelector("button")!;

  const setState = (state: State, title: string) => {
    button.dataset.state = state;
    button.title = title;
    button.innerHTML = ICONS[state];
  };
  setState("idle", "Baixar");

  const swallow = (event: Event) => event.stopPropagation();
  for (const type of ["pointerdown", "mousedown", "mouseup", "touchstart", "dblclick", "keydown"]) {
    host.addEventListener(type, swallow);
  }

  // --- auto-hide: pointer activity over the frame reveals the button ---
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  const hide = () => {
    // Never hide mid-interaction; try again once the state settles.
    if (button.dataset.state !== "idle") return scheduleHide();
    host.style.opacity = "0";
    host.style.visibility = "hidden";
  };
  const scheduleHide = () => {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, HIDE_DELAY_MS);
  };
  const show = () => {
    host.style.opacity = "1";
    host.style.visibility = "visible";
    scheduleHide();
  };
  frame.addEventListener("mousemove", show, { passive: true });
  frame.addEventListener("mouseenter", show, { passive: true });
  frame.addEventListener("mouseleave", () => {
    clearTimeout(hideTimer);
    hide();
  });

  button.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (button.dataset.state === "loading") return;
    setState("loading", "Baixando…");
    show();
    try {
      const ref = getRef();
      if (!ref) throw new Error("Não identifiquei o item");
      const files = filesFromItem(await itemDataFor(ref));
      if (!files.length) throw new Error("Nenhuma mídia encontrada neste item");
      for (const file of files) await download(file);
      setState("done", `${files.length} arquivo(s) salvo(s) em Downloads/TikTok`);
    } catch (err) {
      setState("error", err instanceof Error ? err.message : String(err));
    }
    setTimeout(() => setState("idle", "Baixar"), 3000);
  });

  frame.appendChild(host);
  return host;
}

// --- scanning ----------------------------------------------------------------

function scan() {
  for (const media of document.querySelectorAll<HTMLElement>("video, img")) {
    if (hosts.get(media)?.isConnected) continue;
    const rect = media.getBoundingClientRect();
    if (rect.width < MIN_SIZE || rect.height < MIN_SIZE) continue;
    if (!refNear(media)) continue;
    if (coveredByHost(rect)) continue;
    hosts.set(media, mount(frameFor(media), () => refNear(media)));
  }
}

let scheduled = false;
function schedule() {
  if (scheduled) return;
  scheduled = true;
  setTimeout(() => {
    scheduled = false;
    scan();
  }, 400);
}

new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
window.addEventListener("scroll", schedule, { passive: true });
window.addEventListener("resize", schedule);
window.addEventListener("popstate", schedule);
schedule();
