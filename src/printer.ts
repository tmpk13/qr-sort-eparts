// Client for the print bridge (bridge.py), which hands label images to the thermal printer.

export interface PrinterInfo {
    ok: boolean;
    labelMm: [number, number] | null;
    transport: string;
    error: string;
}

function url(base: string, path: string): string {
    return `${base.replace(/\/+$/, "")}${path}`;
}

export async function printerInfo(base: string): Promise<PrinterInfo> {
    try {
        const r = await fetch(url(base, "/api/printer"), { signal: AbortSignal.timeout(8000) });
        if (!(r.headers.get("content-type") ?? "").includes("json")) {
            return { ok: false, labelMm: null, transport: "", error: `no bridge at ${base || "this server"} (HTTP ${r.status})` };
        }
        const j = await r.json();
        return { ok: !!j.ok, labelMm: j.label_mm ?? null, transport: j.transport ?? "", error: j.error ?? "" };
    } catch (err) {
        return { ok: false, labelMm: null, transport: "", error: `no bridge: ${(err as Error).message}` };
    }
}

export async function printPng(base: string, png: Blob, density: number): Promise<void> {
    const r = await fetch(url(base, `/api/print?density=${density}`), {
        method: "POST",
        headers: { "Content-Type": "image/png" },
        body: png,
        signal: AbortSignal.timeout(60000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) {
        throw new Error(j.error ?? `print failed (${r.status})`);
    }
}

export function downloadBlob(blob: Blob, filename: string): void {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
