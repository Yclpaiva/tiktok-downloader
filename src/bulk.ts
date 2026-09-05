// Bulk download of a user's videos. Runs in the content script: scrolling the
// profile grid feeds itself from the same /api/post/item_list/ calls the SPA
// already makes, captured through a fetch hook injected in the page world.
import { filesFromItem, itemIn, slimItem, videoUrlFrom } from "./tiktok";
import type { ItemRef, ItemStruct, MediaFile } from "./tiktok";

const CAPTURE_EVENT = "tkdl-items";
const SCROLL_STEP = 2000;
const SETTLE_MS = 900;
const STALL_ROUNDS = 3;
const BATCH_EVERY = 10;

// --- settings -----------------------------------------------------------------

export type BulkSettings = {
  /** Pause between two downloads. */
  intervalMs: number;
  /** Extra pause after every BATCH_EVERY downloads; 0 disables. */
  batchPauseMs: number;
  /** Don't refetch items whose files were saved in a previous run. */
  skipExisting: boolean;
  /** One extra pass over the items that failed. */
  retryFailed: boolean;
  /** Filenames already on disk (from chrome.downloads.search). */
  existing: Set<string>;
};

export const DEFAULT_SETTINGS: Omit<BulkSettings, "existing"> = {
  intervalMs: 1000,
  batchPauseMs: 5000,
  skipExisting: true,
  retryFailed: true,
};

/** Fills missing or out-of-range values with defaults; numbers stay finite. */
export function mergeSettings(raw: unknown): Omit<BulkSettings, "existing"> {
  const r = (raw ?? {}) as Record<string, unknown>;
  const num = (value: unknown, fallback: number, max: number) => {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : fallback;
  };
  return {
    intervalMs: num(r.intervalMs, DEFAULT_SETTINGS.intervalMs, 60_000),
    batchPauseMs: num(r.batchPauseMs, DEFAULT_SETTINGS.batchPauseMs, 600_000),
    skipExisting: typeof r.skipExisting === "boolean" ? r.skipExisting : DEFAULT_SETTINGS.skipExisting,
    retryFailed: typeof r.retryFailed === "boolean" ? r.retryFailed : DEFAULT_SETTINGS.retryFailed,
  };
}

// --- fetch capture (page world) ----------------------------------------------

const HOOK_SCRIPT = `
  (() => {
    if (window.__tkdlHooked) return;
    window.__tkdlHooked = true;
    const orig = window.fetch;
    window.fetch = async (...args) => {
      const res = await orig(...args);
      const url = String(typeof args[0] === "string" ? args[0] : args[0]?.url ?? "");
      if (/item_list/.test(url)) {
        try {
          const json = await res.clone().json();
          for (const item of json.itemList ?? []) {
            window.dispatchEvent(new CustomEvent(${JSON.stringify(CAPTURE_EVENT)}, { detail: JSON.stringify(item) }));
          }
        } catch {}
      }
      return res;
    };
  })();
`;

/** Captured items keyed by id, filled passively while the page fetches. */
export const captured = new Map<string, ItemStruct>();

export function installCapture(): void {
  window.addEventListener(CAPTURE_EVENT, (event) => {
    const raw = (event as CustomEvent<string>).detail;
    try {
      const parsed = JSON.parse(raw);
      const item = slimItem(parsed);
      if (item?.id) captured.set(item.id, item);
    } catch {}
  });
  const script = document.createElement("script");
  script.textContent = HOOK_SCRIPT;
  document.documentElement.appendChild(script);
  script.remove();
}

// --- grid collection -----------------------------------------------------------

/** Video refs currently linked in the grid, in document order. */
function gridRefs(): ItemRef[] {
  const refs: ItemRef[] = [];
  for (const a of document.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    const ref = itemIn(a.getAttribute("href") ?? "");
    // Bulk is for videos; photo posts stay out.
    if (ref && /\/video\/\d+/.test(a.getAttribute("href") ?? "")) refs.push(ref);
  }
  return refs;
}

export type Progress =
  | { phase: "exploring"; found: number }
  | { phase: "downloading"; done: number; total: number; fail: number; skipped: number }
  | { phase: "retrying"; done: number; total: number; fail: number }
  | { phase: "finished"; saved: number; fail: number; skipped: number; cancelled: boolean };

export type BulkDeps = {
  resolveData: (ref: ItemRef) => Promise<ItemStruct>;
  downloadFile: (file: MediaFile) => Promise<void>;
};

const sleep = async (ms: number, cancelled: () => boolean) => {
  const step = 200;
  let waited = 0;
  while (waited < ms && !cancelled()) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(step, ms - waited)));
    waited += step;
  }
};

/** Downloads one item, returning false when nothing could be saved. */
async function downloadItem(
  ref: ItemRef,
  settings: BulkSettings,
  deps: BulkDeps,
): Promise<"saved" | "skipped" | "fail"> {
  try {
    const item = captured.get(ref.id) ?? (await deps.resolveData(ref));
    // Bulk is video-only: slideshow posts have no video and are skipped.
    if (!videoUrlFrom(item)) throw new Error("item sem vídeo (slideshow?)");
    const files = filesFromItem(item);
    if (settings.skipExisting && files.every((f) => settings.existing.has(f.filename))) {
      return "skipped";
    }
    for (const file of files) await deps.downloadFile(file);
    return "saved";
  } catch {
    return "fail";
  }
}

/**
 * Scrolls the profile grid to the end, then downloads every video found, one
 * at a time with the configured pauses, reporting progress. `onCancel`
 * resolves when the user clicks the button again; sleeps abort early and the
 * loop stops between downloads.
 */
export async function runBulk(
  settings: BulkSettings,
  deps: BulkDeps,
  onProgress: (progress: Progress) => void,
  onCancel: Promise<void>,
): Promise<void> {
  installCapture();

  // --- explore: scroll until the grid stops growing ---
  const seen = new Map<string, ItemRef>();
  let stalls = 0;
  let cancelled = false;
  onCancel.then(() => (cancelled = true));
  onProgress({ phase: "exploring", found: 0 });
  while (stalls < STALL_ROUNDS && !cancelled) {
    const before = seen.size;
    for (const ref of gridRefs()) if (!seen.has(ref.id)) seen.set(ref.id, ref);
    onProgress({ phase: "exploring", found: seen.size });
    stalls = seen.size === before ? stalls + 1 : 0;
    window.scrollBy(0, SCROLL_STEP);
    await sleep(SETTLE_MS, () => cancelled);
  }
  const refs = [...seen.values()];
  if (cancelled) return onProgress({ phase: "finished", saved: 0, fail: 0, skipped: 0, cancelled: true });

  // --- download: captured data first, iframe only for the gaps ---
  let saved = 0;
  let fail = 0;
  let skipped = 0;
  const failed: ItemRef[] = [];
  for (const [index, ref] of refs.entries()) {
    if (cancelled) break;
    onProgress({ phase: "downloading", done: index, total: refs.length, fail, skipped });
    const outcome = await downloadItem(ref, settings, deps);
    if (outcome === "saved") saved++;
    else if (outcome === "skipped") skipped++;
    else {
      fail++;
      failed.push(ref);
    }
    onProgress({ phase: "downloading", done: index + 1, total: refs.length, fail, skipped });
    if ((index + 1) % BATCH_EVERY === 0 && settings.batchPauseMs > 0 && index + 1 < refs.length) {
      await sleep(settings.batchPauseMs, () => cancelled);
    } else {
      await sleep(settings.intervalMs, () => cancelled);
    }
  }

  // --- retry pass: one more attempt at the failures ---
  if (settings.retryFailed && failed.length && !cancelled) {
    const recovered = failed;
    failed.length = 0;
    let done = 0;
    for (const ref of recovered) {
      if (cancelled) break;
      onProgress({ phase: "retrying", done, total: recovered.length, fail });
      const outcome = await downloadItem(ref, settings, deps);
      if (outcome === "saved") saved++;
      else if (outcome === "skipped") skipped++;
      else failed.push(ref);
      done++;
      onProgress({ phase: "retrying", done, total: recovered.length, fail });
      await sleep(settings.intervalMs, () => cancelled);
    }
    fail = failed.length;
  }
  onProgress({ phase: "finished", saved, fail, skipped, cancelled });
}
