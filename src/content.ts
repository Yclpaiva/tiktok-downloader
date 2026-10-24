import {
  filesFromItem, itemIn, itemUrl, parseItemData, profileIn, type ItemRef, type ItemStruct, type MediaFile,
} from "./tiktok";
import { runBulk, installCapture, type Progress } from "./bulk";
import type { DownloadRequest, DownloadResponse } from "./messages";

const HOST_ATTR = "data-tkdl";
const PROFILE_ATTR = "data-tkdl-bulk";
const MIN_SIZE = 100;
// Same rule as the YT extension: visible while the pointer moves, gone shortly after.
const HIDE_DELAY_MS = 3000;

const hosts = new WeakMap<Element, HTMLElement>();

const ICONS = {
  idle: `<svg viewBox="0 0 24 24"><path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/></svg>`,
  loading: `<svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-6.2-8.56"/></svg>`,
  done: `<svg viewBox="0 0 24 24"><path d="m5 12 5 5L20 7"/></svg>`,
  error: `<svg viewBox="0 0 24 24"><path d="M12 7v6"/><path d="M12 17h.01"/></svg>`,
  all: `<svg viewBox="0 0 24 24"><path d="m12 3 9 5-9 5-9-5Z"/><path d="m3 13 9 5 9-5"/></svg>`,
};
type State = "idle" | "loading" | "done" | "error";

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
    "position:absolute;top:56px;right:10px;z-index:2147483647;width:32px;height:32px;" +
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

// --- profile bulk button -----------------------------------------------------

let cancelBulk: (() => void) | null = null;
const bulkHosts = new WeakMap<Element, HTMLElement>();
const STORAGE_KEY = "bulk";

const PANEL_STYLE = `
  .menu { position: absolute; top: 38px; right: 0; width: 300px; background: #1f1f1f;
    border: 1px solid #3a3a3a; border-radius: 12px; padding: 12px; color: #eee;
    font: 500 13px/1.4 system-ui, sans-serif; box-shadow: 0 8px 24px rgba(0,0,0,.5); }
  .menu[hidden] { display: none; }
  .label { color: #aaa; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; margin: 2px 0 6px; }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 8px 0; }
  .row small { color: #888; display: block; }
  input[type=number] { width: 70px; background: #333; border: 1px solid #555; border-radius: 6px;
    color: #fff; padding: 5px 7px; box-sizing: border-box; }
  input[type=checkbox] { width: 16px; height: 16px; accent-color: #fe2c55; }
  .primary { width: 100%; margin-top: 10px; background: #fe2c55; border-radius: 8px;
    padding: 9px; text-align: center; color: #fff; cursor: pointer; font-weight: 600; }
  .primary:hover { filter: brightness(1.1); }
  .ghost { width: 100%; margin-top: 6px; padding: 5px; text-align: center; color: #aaa; cursor: pointer; }
  .ghost:hover { color: #fff; }
`;

const DEFAULTS = {
  interval: 1,
  batchPause: 5,
  skipExisting: true,
  retryFailed: true,
};

type Settings = typeof DEFAULTS;

async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return { ...DEFAULTS, ...(stored?.[STORAGE_KEY] as Partial<Settings> | undefined) };
}

/**
 * The "download all" button on profile pages, always visible next to the user
 * name. Click opens a settings panel; starting the run closes it. Clicking the
 * button mid-run cancels.
 */
function mountProfileButton() {
  const user = profileIn(location.pathname);
  const title = document.querySelector<HTMLElement>('[data-e2e="user-title"]');
  if (!user || !title || bulkHosts.get(title)?.isConnected) return;

  // Climb from the title to the first ancestor tall enough to hold the button.
  let frame: HTMLElement = title.parentElement ?? title;
  while (frame.parentElement && frame.parentElement !== document.body) {
    const rect = frame.getBoundingClientRect();
    if (rect.height >= 40) break;
    frame = frame.parentElement;
  }
  if (getComputedStyle(frame).position === "static") frame.style.position = "relative";

  const host = document.createElement("div");
  host.setAttribute(PROFILE_ATTR, "");
  host.style.cssText =
    "position:absolute;top:4px;right:10px;z-index:2147483647;width:32px;height:32px;line-height:0;";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>${STYLE}${PANEL_STYLE}</style><button type="button"></button><div class="menu" hidden></div>`;
  const button = root.querySelector("button")!;
  const menu = root.querySelector<HTMLDivElement>(".menu")!;

  const setState = (state: State, tip: string, icon: State | "all" = state) => {
    button.dataset.state = state;
    button.title = tip;
    button.innerHTML = ICONS[icon];
  };
  setState("idle", "Baixar todos os vídeos", "all");

  const swallow = (event: Event) => event.stopPropagation();
  for (const type of ["pointerdown", "mousedown", "mouseup", "touchstart", "dblclick"]) {
    host.addEventListener(type, swallow);
  }

  const closeMenu = () => {
    menu.hidden = true;
    document.removeEventListener("pointerdown", onOutside, true);
  };
  const onOutside = (event: Event) => {
    if (!event.composedPath().includes(host)) closeMenu();
  };

  const onProgress = (progress: Progress) => {
    if (progress.phase === "exploring") {
      setState("loading", `Explorando o canal… ${progress.found} vídeo(s)`);
    } else if (progress.phase === "downloading") {
      setState("loading", `Baixando ${progress.done}/${progress.total} · ${progress.fail} falha(s) — clique para cancelar`);
    } else if (progress.phase === "retrying") {
      setState("loading", `Tentando de novo ${progress.done}/${progress.total} · ${progress.fail} falha(s) — clique para cancelar`);
    } else if (progress.cancelled) {
      setState("done", `Cancelado — ${progress.saved} vídeo(s) salvo(s)`);
    } else if (progress.saved === 0) {
      setState("error", "Nenhum vídeo baixado" + (progress.fail ? ` (${progress.fail} falha(s))` : ""));
    } else {
      const parts = [
        `${progress.saved} vídeo(s) salvo(s)`,
        progress.skipped ? `${progress.skipped} já existia(m)` : "",
        progress.fail ? `${progress.fail} falha(s)` : "",
      ].filter(Boolean);
      setState("done", `${parts.join(" · ")} em Downloads/TikTok`);
    }
  };

  // --- settings panel ---

  const field = <K extends keyof Settings>(key: K, label: string, hint: string) => {
    const row = document.createElement("div");
    row.className = "row";
    const text = document.createElement("label");
    text.innerHTML = `${label}<small>${hint}</small>`;
    row.appendChild(text);
    return row;
  };

  async function openPanel() {
    const settings = await loadSettings();
    const rows = document.createElement("div");
    rows.innerHTML = `<div class="label">Baixar todos os vídeos de @${user}</div>`;

    const intervalRow = field("interval", "Intervalo entre downloads", "segundos de espera entre um vídeo e outro");
    const interval = document.createElement("input");
    interval.type = "number";
    interval.min = "0";
    interval.max = "60";
    interval.step = "0.5";
    interval.value = String(settings.interval);
    intervalRow.appendChild(interval);

    const batchRow = field("batchPause", "Pausa longa a cada 10", "segundos; 0 desativa — ajuda com limites do TikTok");
    const batchPause = document.createElement("input");
    batchPause.type = "number";
    batchPause.min = "0";
    batchPause.max = "600";
    batchPause.value = String(settings.batchPause);
    batchRow.appendChild(batchPause);

    const skipRow = field("skipExisting", "Pular já baixados", "não baixa de novo o que já está na pasta");
    const skip = document.createElement("input");
    skip.type = "checkbox";
    skip.checked = settings.skipExisting;
    skipRow.appendChild(skip);

    const retryRow = field("retryFailed", "Tentar de novo falhas", "uma passada extra nos vídeos que falharam");
    const retry = document.createElement("input");
    retry.type = "checkbox";
    retry.checked = settings.retryFailed;
    retryRow.appendChild(retry);

    const start = document.createElement("div");
    start.className = "primary";
    start.textContent = "Baixar tudo";
    const close = document.createElement("div");
    close.className = "ghost";
    close.textContent = "Fechar";
    close.addEventListener("click", closeMenu);

    rows.append(intervalRow, batchRow, skipRow, retryRow, start, close);
    menu.replaceChildren(rows);
    menu.hidden = false;
    document.addEventListener("pointerdown", onOutside, true);

    start.addEventListener("click", async () => {
      const chosen: Settings = {
        interval: Math.max(0, Number(interval.value) || 0),
        batchPause: Math.max(0, Number(batchPause.value) || 0),
        skipExisting: skip.checked,
        retryFailed: retry.checked,
      };
      closeMenu();
      await chrome.storage.local.set({ [STORAGE_KEY]: chosen });
      startBulk(chosen);
    });
  }

  async function startBulk(settings: Settings) {
    const startedAt = location.pathname;
    const onCancel = new Promise<void>((resolve) => {
      cancelBulk = () => {
        cancelBulk = null;
        resolve();
      };
    });
    // Leaving the profile also stops the run.
    const navWatch = setInterval(() => {
      if (location.pathname !== startedAt) cancelBulk?.();
    }, 400);

    let existing = new Set<string>();
    if (settings.skipExisting) {
      const res = (await chrome.runtime.sendMessage({ type: "bulk-existing" })) as { names?: string[] } | undefined;
      existing = new Set(res?.names ?? []);
    }

    setState("loading", "Explorando o canal…");
    runBulk(
      {
        intervalMs: settings.interval * 1000,
        batchPauseMs: settings.batchPause * 1000,
        skipExisting: settings.skipExisting,
        retryFailed: settings.retryFailed,
        existing,
      },
      { resolveData: itemDataFor, downloadFile: download },
      (progress) => {
        onProgress(progress);
        if (progress.phase === "finished") clearInterval(navWatch);
      },
      onCancel,
    ).then(() => {
      clearInterval(navWatch);
      cancelBulk = null;
      setTimeout(() => setState("idle", "Baixar todos os vídeos", "all"), 4000);
    });
  }

  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (cancelBulk) {
      cancelBulk();
      setState("loading", "Cancelando… aguarde o download em andamento terminar");
      return;
    }
    menu.hidden ? openPanel() : closeMenu();
  });

  frame.appendChild(host);
  bulkHosts.set(title, host);
}

// --- scanning ----------------------------------------------------------------

function scan() {
  mountProfileButton();
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
// Before the SPA's own item_list calls, so every profile batch gets captured.
installCapture();
schedule();
