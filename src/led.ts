// Status colors for the optional USB LED driven through the bridge. Silent when the bridge or the
// LED is missing; asks again every so often in case one is plugged in later.
import { bridgeUrl } from "./printer.ts";
import { settings } from "./settings.ts";

export type LedState = "off" | "idle" | "seen" | "ok" | "unknown" | "nocode" | "elsewhere" | "err";

// Physical LED colors: full channels read better on a diffused LED than the screen palette does.
export const LED_COLORS: Record<LedState, string> = {
    off: "#000000",
    idle: "#000010", // camera running, nothing in view
    seen: "#001818", // a code is in view, settling
    ok: "#00ff00", // saved
    unknown: "#ff00a0", // saved among the unidentified codes
    nocode: "#8000ff", // a bag with no code: its photo kept among the unidentified photos
    elsewhere: "#ff8000", // the part was already in another bag of this box
    err: "#ff0000",
};

const RECHECK_MS = 10000;

let steady: LedState = "off";
let holdUntil = 0;
let holdTimer: ReturnType<typeof setTimeout> | undefined;
let desired = LED_COLORS.off;
let shown = "";
let sending = false;
let attached: boolean | null = null;
let checkedAt = 0;

/** The steady state: camera off, scanning, or a code in view. Cheap to call on every frame. */
export function ledSteady(state: LedState): void {
    steady = state;
    if (Date.now() >= holdUntil) {
        show(state);
    }
}

/** A momentary state shown for holdMs before the steady one returns. */
export function ledFlash(state: LedState, holdMs = 1500): void {
    holdUntil = Date.now() + holdMs;
    show(state);
    clearTimeout(holdTimer);
    holdTimer = setTimeout(() => {
        holdUntil = 0;
        show(steady);
    }, holdMs);
}

function show(state: LedState): void {
    desired = LED_COLORS[state];
    void pump();
}

/** One request at a time, always ending on the latest color, so replies arriving late cannot reorder colors. */
async function pump(): Promise<void> {
    if (sending || !settings.value.led) {
        return;
    }
    sending = true;
    try {
        while (desired !== shown && (await present())) {
            const color = desired;
            if (!(await post(color))) {
                attached = false;
                shown = "";
                break;
            }
            shown = color;
        }
    } finally {
        sending = false;
    }
}

async function present(): Promise<boolean> {
    const now = Date.now();
    if (attached === null || (!attached && now - checkedAt > RECHECK_MS)) {
        checkedAt = now;
        try {
            const r = await fetch(bridgeUrl(settings.value.bridgeUrl, "/api/led"), { signal: AbortSignal.timeout(3000) });
            attached = r.ok && (r.headers.get("content-type") ?? "").includes("json") && !!(await r.json()).attached;
        } catch {
            attached = false;
        }
    }
    return attached;
}

async function post(color: string): Promise<boolean> {
    try {
        const r = await fetch(bridgeUrl(settings.value.bridgeUrl, "/api/led"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ color }),
            signal: AbortSignal.timeout(3000),
        });
        return r.ok && !!(await r.json()).attached;
    } catch {
        return false;
    }
}
