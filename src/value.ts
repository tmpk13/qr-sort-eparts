// Component values: read from the common resistor and capacitor part number schemes and from label
// descriptions, written the way they are usually spoken ("4.7k", "100R", "100nF", "10uH"), and
// turned back into numbers so lists can be sorted by them.

export type Unit = "R" | "F" | "H";

// Prefix letters in lower case, except M (mega) which differs from m (milli); r is a decimal point in ohms.
const SCALE: Record<string, number> = { p: 1e-12, n: 1e-9, u: 1e-6, m: 1e-3, "": 1, r: 1, k: 1e3, M: 1e6, g: 1e9 };

/** The scale of a prefix letter written in either case; only M and m differ. */
function scaleOf(letter: string): number {
    return SCALE[letter === "M" ? "M" : letter.toLowerCase()] ?? NaN;
}

/** Micro signs (the micro sign and the Greek mu, written as escapes) as the letter u. */
function asciiMicro(text: string): string {
    return text.replace(/[\u00b5\u03bc]/g, "u");
}

// Prefixes used for each unit, largest first. Capacitors stay in uF above 1000 ("2200uF"), the way
// electrolytics are labeled; ohms take no unit letter below 1k ("100R").
const PREFIXES: Record<Unit, [string, number][]> = {
    R: [["G", 1e9], ["M", 1e6], ["k", 1e3], ["R", 1]],
    F: [["F", 1], ["uF", 1e-6], ["nF", 1e-9], ["pF", 1e-12]],
    H: [["H", 1], ["mH", 1e-3], ["uH", 1e-6], ["nH", 1e-9]],
};

/** 4700 ohms -> "4.7k", 1e-7 farads -> "100nF", 0.1 ohms -> "0.1R"; three significant digits at most. */
export function formatValue(n: number, unit: Unit): string {
    if (!Number.isFinite(n) || n < 0) {
        return "";
    }
    const x = Number(n.toPrecision(3));
    const prefixes = PREFIXES[unit];
    const [suffix, scale] = prefixes.find(([, s]) => x >= s) ?? prefixes[prefixes.length - 1];
    return `${Number((x / scale).toPrecision(3))}${suffix}`;
}

/**
 * A value as written ("4.7k", "4k7", "R47", "100R", "100nF", "0.1 uF", "10uH", "1M ohm") in base
 * units, for sorting; NaN when it is not a value. Upper case M is mega, lower case m is milli.
 */
export function valueNumber(v: string): number {
    // Trailing ohm signs (Greek omega and the ohm sign) are written as escapes.
    const s = asciiMicro(v).trim().replace(/\s+/g, "").replace(/(ohms?|\u03a9|\u2126)$/i, "");
    // A unit letter after a prefix ("100nF", "10uH", "10mR") or digits ("1F") carries no scale of its own;
    // "100R" keeps its R, which stands where the prefix would.
    const bare = s.replace(/^([\d.]*[pnumkMG]?\d*)[FH]$/i, "$1").replace(/^([\d.]+[pnumkMG])R$/i, "$1");
    const m = /^(\d*)(?:\.(\d+))?([pnumkMGR]?)(\d*)$/i.exec(bare);
    if (!m || (!m[1] && !m[2] && !m[4]) || (m[2] && m[4])) {
        return NaN;
    }
    const [, whole, frac, prefix, tail] = m;
    const num = Number(`${whole || "0"}.${frac || tail || "0"}`);
    return num * scaleOf(prefix);
}

/**
 * The number an EIA value code stands for, in ohms or picofarads: "103" -> 10000, "1002" -> 10000,
 * "4R7" -> 4.7, "R10" -> 0.1, "4K7" -> 4700, "10K0" -> 10000. Null for anything else.
 */
export function eiaValue(code: string): number | null {
    if (/^\d{3,4}$/.test(code)) {
        const last = Number(code.slice(-1));
        // In the three-digit capacitor code 8 and 9 multiply by 0.01 and 0.1.
        const exp = last === 8 ? -2 : last === 9 ? -1 : last;
        return Number(code.slice(0, -1)) * 10 ** exp;
    }
    if (/^(\d*R\d+|\d+R\d*)$/.test(code)) {
        return Number(code.replace("R", "."));
    }
    const k = /^(\d+)([KMG])(\d*)$/.exec(code);
    return k ? Number(`${k[1]}.${k[3] || "0"}`) * scaleOf(k[2]) : null;
}

// Where the value sits in each family's part number, and whether it counts ohms or picofarads.
// A convenience for the common families, not a catalog; the value stays editable.
const FAMILIES: [RegExp, Unit][] = [
    // Yageo RC, AC, RT: RC0805FR-0710KL, RC0402JR-074K7L, RT0603BRD07100RL
    [/^(?:RC|AC|RT)\d{4}[A-Z]{2,3}-?\d{2}(\d*[RKM]\d*)[A-Z]?$/, "R"],
    // Vishay CRCW, TNPW: CRCW080510K0FKEA, CRCW0805R100FNEA
    [/^(?:CRCW|TNPW)\d{4}(\d+[RKM]\d*|R\d+)[A-Z]/, "R"],
    // Stackpole RMCF, RMCP, RNCP, RNCF: RMCF0805FT10K0, RNCP0805FTD10K0
    [/^(?:RMCF|RMCP|RNCP|RNCF)\d{4}[A-Z]{1,3}?(\d+[RKM]\d*|R\d+)$/, "R"],
    // Panasonic ERJ and ERA: ERJ-3EKF1002V, ERJ-6GEYJ103V, ERA-3AEB103V
    [/^ER[JA]-?[A-Z0-9]+?(\d{3,4}|\d+R\d*|R\d+)[A-Z]$/, "R"],
    // KOA RK73: RK73H2ATTD1002F
    [/^RK73[A-Z]\d[A-Z][A-Z]{1,3}?(\d{3,4}|\d+R\d*|R\d+)[A-Z]$/, "R"],
    // Bourns CR: CR0805-FX-1002ELF
    [/^CR\d{4}-[A-Z]{2}-(\d{3,4}|\d+R\d*|R\d+)[A-Z]/, "R"],
    // UniOhm: 0805W8F1002T5E
    [/^\d{4}W[0-9A-Z][A-Z](\d{3,4}|\d+R\d*|R\d+)T[0-9A-Z]E$/, "R"],
    // TDK: C1608X7R1H104K080AA (tried before KEMET, whose shape it also fits)
    [/^C\d{4}[A-Z0-9]{3}\d[A-Z](\d{3}|\dR\d|R\d{2})[A-Z]/, "F"],
    // KEMET: C0805C104K5RACTU
    [/^C\d{4}[A-Z](\d{3}|\dR\d|R\d{2})[A-Z]\d/, "F"],
    // Samsung CL: CL21A106KAYNNNE
    [/^CL\d{2}[A-Z](\d{3}|\dR\d|R\d{2})[A-Z]/, "F"],
    // Murata GRM, GCM, GJM, GRT, GCJ, GQM: GRM188R71H104KA93D
    [/^G(?:RM|CM|JM|RT|CJ|QM)[0-9A-Z]{3}[0-9A-Z]{2}[0-9A-Z]{2}(\d{3}|\dR\d|R\d{2})[A-Z]/, "F"],
    // Yageo CC: CC0805KRX7R9BB104
    [/^CC\d{4}[A-Z]{2}[A-Z0-9]{3}\d[A-Z]{2}(\d{3}|\dR\d|R\d{2})$/, "F"],
    // KYOCERA AVX: 08055C104KAT2A, 0603YC104KAT2A
    [/^\d{4}[0-9A-Z][A-Z](\d{3}|\dR\d|R\d{2})[A-Z]{2}T/, "F"],
    // Panasonic ECJ: ECJ-1VB1C105K
    [/^ECJ-?[0-9A-Z]{3}\d[A-Z](\d{3}|\dR\d)[A-Z]/, "F"],
];

/** The value a part number spells out, for the common resistor and capacitor families; "" when unknown. */
export function valueFromPartNumber(mpn: string): string {
    const m = mpn.trim().toUpperCase();
    for (const [re, unit] of FAMILIES) {
        const code = re.exec(m)?.[1];
        const n = code ? eiaValue(code) : null;
        if (n != null) {
            return formatValue(unit === "F" ? n * 1e-12 : n, unit);
        }
    }
    return "";
}

// Matched against the upper-cased description, micro signs already turned into U.
const DESC: Record<Unit, RegExp> = {
    R: /(\d+(?:\.\d+)?)\s*([KMG]?)\s*OHMS?\b/,
    F: /(\d+(?:\.\d+)?)\s*([PNU])F\b/,
    H: /(\d+(?:\.\d+)?)\s*([PNUM])H\b/,
};

/**
 * The value in a label description: "RES 10K OHM 1% 1/8W 0805" -> "10k", "CAP CER 0.1UF 50V X7R"
 * -> "100nF", "FIXED IND 10UH 1A 100 MOHM" -> "10uH" (the word in front picks the unit, so an
 * inductor's resistance is not taken for its value); "" when none is found.
 */
export function valueFromDescription(desc: string): string {
    const d = asciiMicro(desc).toUpperCase();
    const first: Unit | null = /\bIND/.test(d) ? "H" : /\bCAP/.test(d) ? "F" : /\bRES/.test(d) ? "R" : null;
    const order: Unit[] = first ? [first, ...(["R", "F", "H"] as Unit[]).filter((u) => u !== first)] : ["R", "F", "H"];
    for (const unit of order) {
        const m = DESC[unit].exec(d);
        if (m) {
            // Descriptions are upper case: M is mega in ohms and milli in henries.
            const scale = unit === "H" && m[2] === "M" ? SCALE.m : scaleOf(m[2]);
            return formatValue(Number(m[1]) * scale, unit);
        }
    }
    return "";
}

/** Orders values by their size; ones that are not values come after, alphabetically. */
export function compareValues(a: string, b: string): number {
    const x = valueNumber(a);
    const y = valueNumber(b);
    if (Number.isNaN(x) || Number.isNaN(y)) {
        return Number.isNaN(x) === Number.isNaN(y) ? a.localeCompare(b, undefined, { numeric: true }) : Number.isNaN(x) ? 1 : -1;
    }
    return x - y;
}
