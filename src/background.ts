import type { ContentRequest, ContentResponse } from "./messages";

const sanitize = (name: string) => name.replace(/[\\/:*?"<>|]+/g, "_");

chrome.runtime.onMessage.addListener(
  (message: ContentRequest, _sender, sendResponse: (r: ContentResponse) => void) => {
    if (message?.type === "bulk-existing") {
      chrome.downloads.search({ filename: "TikTok/*" }, (items) => {
        const names = items
          .filter((item) => item.state === "complete")
          .map((item) => item.filename.split("/").pop() ?? "")
          .filter(Boolean);
        sendResponse({ names });
      });
      return true;
    }
    if (message?.type !== "download") return false;
    chrome.downloads
      .download({
        url: message.url,
        filename: `TikTok/${sanitize(message.filename)}`,
        conflictAction: "uniquify",
        saveAs: false,
      })
      .then(() => sendResponse({ ok: true }))
      .catch((err: unknown) => sendResponse({ ok: false, error: String(err) }));
    return true;
  },
);
