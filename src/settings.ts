// User settings, kept in localStorage.
import { useEffect, useState } from "preact/hooks";

export interface Settings {
    autoScan: boolean; // capture by itself when a new bag enters the frame
    autoSave: boolean; // save a capture without confirmation
    savePhotos: boolean; // keep the camera frame with each item
    bridgeUrl: string; // print bridge origin, empty for the page's own
    labelW: number; // label size in mm, used when the printer cannot be asked
    labelH: number;
    density: number; // burn density 0-15
    cameraId: string;
    currentBagId: string | null; // the bag being filled
    typeHints: Record<string, string>; // part number family -> type chosen by the user
}

export const DEFAULTS: Settings = {
    autoScan: true, autoSave: true, savePhotos: true, bridgeUrl: "", labelW: 40, labelH: 30, density: 4,
    cameraId: "", currentBagId: null, typeHints: {},
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
