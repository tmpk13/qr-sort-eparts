import { describe, expect, test } from "bun:test";
import { familyKey, guessType, identifiable, joinLinear, parseCode, parseIso15434, parseLabelText, parseLcsc }
    from "../src/parse.ts";
import { DK_NEW, DK_OLD, EOT, GS, LCSC, MOUSER, RS } from "./fixtures.ts";

describe("DigiKey labels", () => {
    test("older label: P is the DigiKey part number", () => {
        const p = parseCode(DK_OLD);
        expect(p.source).toBe("digikey");
        expect(p.vendorPn).toBe("296-8286-1-ND");
        expect(p.mpn).toBe("SN74LVC1G08DBVR");
        expect(p.qty).toBe(10);
        expect(p.dateCode).toBe("2238");
        expect(p.lot).toBe("ABC123");
        expect(p.country).toBe("CN");
        expect(p.notes).toBe("");
        expect(p.fields.K).toBe("");
        expect(p.fields["12Z"]).toBe("3178254");
        expect(p.raw).toBe(DK_OLD);
    });

    test("newer label: 30P is the DigiKey part number and P the customer's", () => {
        const p = parseCode(DK_NEW);
        expect(p.source).toBe("digikey");
        expect(p.vendorPn).toBe("311-10KARCT-ND");
        expect(p.mpn).toBe("RC0805FR-0710KL");
        expect(p.qty).toBe(100);
        expect(p.notes).toBe("Customer PN MYCUSTPN");
    });

    test("human readable separators are accepted", () => {
        const hri = DK_OLD.replace(new RegExp(RS, "g"), "{RS}").replace(new RegExp(GS, "g"), "{GS}")
            .replace(EOT, "{EOT}");
        const p = parseCode(hri);
        expect(p.source).toBe("digikey");
        expect(p.mpn).toBe("SN74LVC1G08DBVR");
        expect(p.qty).toBe(10);
    });

    test("fields without the envelope still parse", () => {
        const p = parseIso15434(`P296-8286-1-ND${GS}1PSN74${GS}Q5`);
        expect(p?.source).toBe("digikey");
        expect(p?.qty).toBe(5);
    });

    test("a trailing newline from a keyboard wedge is ignored", () => {
        expect(parseCode(DK_OLD + "\r\n").fields["20Z"]).toBe("000000");
    });
});

describe("other vendors", () => {
    test("Mouser", () => {
        const p = parseCode(MOUSER);
        expect(p.source).toBe("mouser");
        expect(p.mpn).toBe("GRM188R71H104KA93D");
        expect(p.manufacturer).toBe("Murata");
        expect(p.qty).toBe(100);
        expect(p.country).toBe("JP");
        expect(p.vendorPn).toBe("");
    });

    test("LCSC", () => {
        const p = parseCode(LCSC);
        expect(p.source).toBe("lcsc");
        expect(p.mpn).toBe("STM32F103C8T6");
        expect(p.vendorPn).toBe("C14663");
        expect(p.qty).toBe(10);
        expect(parseLcsc("{not json at all")).toBeNull();
        expect(parseLcsc('{"a":1}')).toBeNull();
    });

    test("anything else is text", () => {
        const p = parseCode("hello world");
        expect(p.source).toBe("text");
        expect(p.raw).toBe("hello world");
        expect(p.mpn).toBe("");
        expect(parseCode(`[)>${RS}06${GS}garbage without identifiers`).source).toBe("text");
        expect(parseCode("[)>06P123").source).toBe("text");
    });

    test("generic ISO 15434 content keeps its fields", () => {
        const p = parseCode(`[)>${RS}06${GS}1PABC${GS}Q7${GS}S123${RS}${EOT}`);
        expect(p.source).toBe("iso15434");
        expect(p.mpn).toBe("ABC");
        expect(p.fields.S).toBe("123");
    });
});

describe("type heuristic", () => {
    const cases: [string, string][] = [
        ["RC0805FR-0710KL", "resistor"], ["ERJ-3EKF1002V", "resistor"], ["CL21A106KAYNNNE", "capacitor"],
        ["GRM188R71H104KA93D", "capacitor"], ["TPSB107K006R0500", "capacitor"], ["TPS62840DLCR", "ic"],
        ["STM32F103C8T6", "mcu"], ["ATMEGA328P-AU", "mcu"], ["SN74LVC1G08DBVR", "ic"], ["LM358DR", "ic"],
        ["1N4148W-7-F", "diode"], ["SS14", "diode"], ["LTST-C191KRKT", "led"], ["MMBT3904", "transistor"],
        ["IRLML6344TRPBF", "transistor"], ["ESP32-WROOM-32E", "module"], ["ESP32-C3FH4", "mcu"],
        ["B3F-1000", "switch"], ["ABM8-16.000MHZ-B2-T", "crystal"], ["S2B-PH-K-S", "connector"],
        ["LQW18AN10NG00D", "inductor"], ["744771133", "inductor"], ["", ""], ["ZZZ-UNKNOWN", ""],
    ];
    for (const [mpn, type] of cases) {
        test(`${mpn || "(empty)"} -> ${type || "(unknown)"}`, () => expect(guessType(mpn)).toBe(type));
    }

    test("family keys", () => {
        expect(familyKey("RC0805FR-0710KL")).toBe("RC0");
        expect(familyKey("rc0603")).toBe("RC0");
        expect(familyKey("1N4148")).toBe("1N4");
        expect(familyKey("STM32F103")).toBe("STM3");
        expect(familyKey("LTST-C191")).toBe("LTST");
        expect(familyKey("")).toBe("");
    });
});

describe("customer references on DigiKey labels", () => {
    test("a P that is not a DigiKey number is kept as the customer's, not as the vendor PN", () => {
        const p = parseCode(`[)>${RS}06${GS}PU7${GS}1PMCP1703AT-3302E/CB${GS}K${GS}1K58605004${GS}10K67045066${GS}11K1` +
            `${GS}4LTW${GS}Q10${GS}11ZPICK${GS}12Z1${GS}13Z2${RS}${EOT}`);
        expect(p.source).toBe("digikey");
        expect(p.vendorPn).toBe("");
        expect(p.mpn).toBe("MCP1703AT-3302E/CB");
        expect(p.notes).toBe("Customer PN U7");
    });

    test("Mouser keeps P as its own number", () => {
        expect(parseCode(`[)>${RS}06${GS}K1${GS}14K001${GS}P595-SN74${GS}1PSN74${RS}${EOT}`).vendorPn).toBe("595-SN74");
    });
});

describe("rows of 1D barcodes", () => {
    test("data identifiers in view join into one message", () => {
        const joined = joinLinear(["Q100", "1PGRM188R71H104KA93D", "4LJP", "1VMurata"]);
        expect(joined).not.toBeNull();
        const p = parseCode(joined!);
        expect(p.source).toBe("mouser");
        expect(p).toMatchObject({ mpn: "GRM188R71H104KA93D", qty: 100, country: "JP", manufacturer: "Murata" });
    });

    test("a DigiKey number alone is enough", () => {
        expect(parseCode(joinLinear(["P296-8286-1-ND"])!).vendorPn).toBe("296-8286-1-ND");
    });

    test("codes that do not name a part are ignored", () => {
        expect(joinLinear([])).toBeNull();
        expect(joinLinear(["Q100", "4LCN"])).toBeNull();
        expect(joinLinear(["PIC16F84A"])).toBeNull(); // a bare part number reads as P + "IC16F84A"
        expect(joinLinear(["4006381333931"])).toBeNull();
        expect(joinLinear(["PIC16F84A", "Q5"])).not.toBeNull();
    });

    test("the first of a repeated identifier wins", () => {
        expect(parseCode(joinLinear(["1PA1", "1PB2"])!).mpn).toBe("A1");
    });
});

describe("label text", () => {
    const lines = (...t: [string, number][]) => t.map(([text, confidence]) => ({ text, confidence }));

    test("a DigiKey label", () => {
        const r = parseLabelText(lines(["DIGI-KEY PART NO.: 296-8286-1-ND", 91], ["MANUFACTURER PART NO.: SN74LVC1G08DBVR", 88],
            ["DESCRIPTION: IC GATE AND 1CH 2-INP SOT23-5", 80], ["QUANTITY: 1,000", 95]));
        expect(r).toMatchObject({ source: "ocr", vendorPn: "296-8286-1-ND", mpn: "SN74LVC1G08DBVR", qty: 1000 });
        expect(r!.fields).toMatchObject({ vendor: "DIGIKEY", desc: "IC GATE AND 1CH 2-INP SOT23-5" });
        expect(r!.confidence).toBe(80);
    });

    test("Mouser and LCSC spellings", () => {
        expect(parseLabelText(lines(["Mouser P/N: 595-SN74LVC1G08DBVR", 90], ["Mfr P/N: SN74LVC1G08DBVR.", 85],
            ["Qty: 25", 92]))).toMatchObject({ vendorPn: "595-SN74LVC1G08DBVR", mpn: "SN74LVC1G08DBVR", qty: 25 });
        expect(parseLabelText(lines(["LCSC Part #: C14663", 70], ["Mfr. Part #: STM32F103C8T6", 75])))
            .toMatchObject({ vendorPn: "C14663", mpn: "STM32F103C8T6", confidence: 70 });
    });

    test("a DigiKey number without its caption still counts", () => {
        expect(parseLabelText(lines(["311-10KARCT-ND", 77]))?.vendorPn).toBe("311-10KARCT-ND");
    });

    test("text without a part number is not a read", () => {
        expect(parseLabelText(lines(["QTY: 10", 99], ["Made in Taiwan", 90]))).toBeNull();
        expect(parseLabelText([])).toBeNull();
    });

    test("identifiable means a part number of either kind", () => {
        expect(identifiable({ mpn: "", vendorPn: " " })).toBe(false);
        expect(identifiable({ mpn: "", vendorPn: "C1" })).toBe(true);
    });
});
