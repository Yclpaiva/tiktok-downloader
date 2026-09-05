export type DownloadRequest = { type: "download"; url: string; filename: string };
export type DownloadResponse = { ok: true } | { ok: false; error: string };

/** Asks which bulk files are already saved, so a new run can skip them. */
export type ExistingRequest = { type: "bulk-existing" };
export type ExistingResponse = { names: string[] };

export type ContentRequest = DownloadRequest | ExistingRequest;
export type ContentResponse = DownloadResponse | ExistingResponse;
