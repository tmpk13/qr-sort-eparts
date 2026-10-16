import { describe, expect, test } from "bun:test";
import { familyKey, guessType, parseCode, parseIso15434, parseLcsc } from "../src/parse.ts";
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
