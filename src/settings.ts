// User settings, kept in localStorage.
import { useEffect, useState } from "preact/hooks";
import type { MarkerTune } from "./marker.ts";
import type { ItemOrder } from "./model.ts";

export interface Settings {
    autoScan: boolean; // capture by itself when a new bag enters the frame
    autoSave: boolean; // save a capture without confirmation
    savePhotos: boolean; // keep the camera frame with each item
    bridgeUrl: string; // print bridge origin, empty for the page's own
    labelW: number; // label size in mm, used when the printer cannot be asked
    labelH: number;
    density: number; // burn density 0-15
    cameraId: string;
    zoom: number; // camera zoom, by the camera itself where it can, else by cropping
    stills: boolean; // take a full-resolution still when a code is seen but will not read
    textFallback: boolean; // read the label's printed text when there is no code
    ocrConfidence: number; // 0-100: text reads below this are not used
    led: boolean; // drive the status LED on the bridge when one is attached
    currentBagId: string | null; // the bag being filled
    batchMode: boolean; // scans go into the current batch instead of a bag
    currentBatchId: string | null;
    typeHints: Record<string, string>; // part number family -> type chosen by the user
    sortItems: ItemOrder; // items in bags and boxes as scanned, or by type
    marker: MarkerTune | null; // the color of the marker counts are written on bags with
    readMarker: boolean; // read the count written in that color off each bag's photo
    markerConfidence: number; // 0-100: counts read below this are not used
}

export const DEFAULTS: Settings = {
    autoScan: true, autoSave: true, savePhotos: true, bridgeUrl: "", labelW: 40, labelH: 30, density: 4,
    cameraId: "", zoom: 1, stills: true, textFallback: false, ocrConfidence: 70, led: true, currentBagId: null,
    batchMode: false, currentBatchId: null, typeHints: {}, sortItems: "scanned", marker: null, readMarker: false,
    markerConfidence: 70,
};

const KEY = "qr-sort.settings";

class SettingsStore {
    value: Settings = load();
    private listeners = new Set<(s: Settings) => void>();

    set(patch: Partial<Settings>): void {
        this.value = { ...this.value, ...patch };
        try {
            localStorage.setItem(KEY, JSON.stringify(this.value));
        } catch {
            // private mode or storage disabled: settings last for the session only
        }
        for (const l of this.listeners) {
            l(this.value);
        }
    }

    subscribe(fn: (s: Settings) => void): () => void {
        this.listeners.add(fn);
        return () => {
            this.listeners.delete(fn);
        };
    }
}

function load(): Settings {
    try {
        const raw = typeof localStorage !== "undefined" ? localStorage.getItem(KEY) : null;
        return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
    } catch {
        return { ...DEFAULTS };
    }
}

export const settings = new SettingsStore();

export function useSettings(): [Settings, (patch: Partial<Settings>) => void] {
    const [value, setValue] = useState(settings.value);
    useEffect(() => settings.subscribe(setValue), []);
    return [value, (patch) => settings.set(patch)];
}
