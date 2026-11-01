import { describe, expect, test } from "bun:test";
import { compareValues, eiaValue, formatValue, valueFromDescription, valueFromPartNumber, valueNumber }
    from "../src/value.ts";

describe("component values", () => {
    test("written with an engineering prefix, three significant digits", () => {
        expect(formatValue(4700, "R")).toBe("4.7k");
        expect(formatValue(100, "R")).toBe("100R");
        expect(formatValue(0.1, "R")).toBe("0.1R");
        expect(formatValue(0, "R")).toBe("0R");
        expect(formatValue(49.9, "R")).toBe("49.9R");
        expect(formatValue(2.2e6, "R")).toBe("2.2M");
        expect(formatValue(1e5 * 1e-12, "F")).toBe("100nF");
        expect(formatValue(1e6 * 1e-12, "F")).toBe("1uF");
        expect(formatValue(2.2e-3, "F")).toBe("2200uF");
        expect(formatValue(22e-12, "F")).toBe("22pF");
        expect(formatValue(0.5e-12, "F")).toBe("0.5pF");
        expect(formatValue(10e-6, "H")).toBe("10uH");
        expect(formatValue(-1, "R")).toBe("");
    });

    test("read back as numbers in base units, in the ways they are written", () => {
        expect(valueNumber("4.7k")).toBeCloseTo(4700);
        expect(valueNumber("4k7")).toBeCloseTo(4700);
        expect(valueNumber("4K7")).toBeCloseTo(4700);
        expect(valueNumber("R47")).toBeCloseTo(0.47);
        expect(valueNumber("100R")).toBe(100);
        expect(valueNumber("10")).toBe(10);
        expect(valueNumber("1M")).toBe(1e6);
        expect(valueNumber("10 k ohm")).toBeCloseTo(1e4);
        expect(valueNumber("4.7 \u03a9")).toBeCloseTo(4.7);
        expect(valueNumber("100nF")).toBeCloseTo(1e-7);
        expect(valueNumber("100NF")).toBeCloseTo(1e-7);
        expect(valueNumber("0.1 uF")).toBeCloseTo(1e-7);
        expect(valueNumber("4.7\u00b5F")).toBeCloseTo(4.7e-6);
        expect(valueNumber("10uH")).toBeCloseTo(1e-5);
        expect(valueNumber("10mR")).toBeCloseTo(0.01);
        expect(valueNumber("")).toBeNaN();
        expect(valueNumber("k")).toBeNaN();
        expect(valueNumber("1.5k5")).toBeNaN();
        expect(valueNumber("SOT-23")).toBeNaN();
    });

    test("EIA codes in ohms or picofarads", () => {
        expect(eiaValue("103")).toBe(10000);
        expect(eiaValue("1002")).toBe(10000);
        expect(eiaValue("4701")).toBe(4700);
        expect(eiaValue("220")).toBe(22);
        expect(eiaValue("000")).toBe(0);
        expect(eiaValue("4R7")).toBeCloseTo(4.7);
        expect(eiaValue("R10")).toBeCloseTo(0.1);
        expect(eiaValue("0R")).toBe(0);
        expect(eiaValue("10K0")).toBe(10000);
        expect(eiaValue("2M2")).toBeCloseTo(2.2e6);
        expect(eiaValue("ABC")).toBeNull();
    });

    test("resistor part numbers", () => {
        const cases: [string, string][] = [
            ["RC0805FR-0710KL", "10k"], ["RC0805FR-071KL", "1k"], ["RC0402JR-074K7L", "4.7k"],
            ["RC0805FR-07100RL", "100R"], ["RC0603JR-070RL", "0R"], ["RC1206FR-071ML", "1M"],
            ["RC0603FR-0749R9L", "49.9R"], ["RT0603BRD07100RL", "100R"], ["AC0805FR-0710KL", "10k"],
            ["CRCW080510K0FKEA", "10k"], ["CRCW0603100RFKEA", "100R"], ["CRCW06034K70FKEA", "4.7k"],
            ["CRCW0805R100FNEA", "0.1R"], ["TNPW060310K0BEEA", "10k"],
            ["RMCF0805FT10K0", "10k"], ["RNCP0805FTD10K0", "10k"], ["RMCF0603JT100R", "100R"],
            ["ERJ-3EKF1002V", "10k"], ["ERJ-6GEYJ103V", "10k"], ["ERJ-P06J103V", "10k"], ["ERJ-2GE0R00X", "0R"],
            ["ERJ-6ENF10R0V", "10R"], ["ERA-3AEB103V", "10k"],
            ["RK73H2ATTD1002F", "10k"], ["RK73B1JTTD103J", "10k"],
            ["CR0805-FX-1002ELF", "10k"], ["0805W8F1002T5E", "10k"], ["0603WAF4701T5E", "4.7k"],
        ];
        for (const [mpn, value] of cases) {
            expect([mpn, valueFromPartNumber(mpn)]).toEqual([mpn, value]);
        }
    });

    test("capacitor part numbers", () => {
        const cases: [string, string][] = [
            ["C1608X7R1H104K080AA", "100nF"], ["C2012X5R1A106K125AB", "10uF"], ["C1005C0G1H101J050BA", "100pF"],
            ["C0805C104K5RACTU", "100nF"], ["C0603C220J5GACTU", "22pF"], ["C0402C1R0C5GACTU", "1pF"],
            ["C1206C106K4PACTU", "10uF"], ["CL21A106KAYNNNE", "10uF"], ["CL10B104KB8NNNC", "100nF"],
            ["CL05C220JB5NNNC", "22pF"], ["CL10C1R5BB8NNNC", "1.5pF"], ["GRM188R71H104KA93D", "100nF"],
            ["GRM21BR61E106KA73L", "10uF"], ["GRM1555C1H101JA01D", "100pF"], ["GCM155R71H104KE02D", "100nF"],
            ["CC0805KRX7R9BB104", "100nF"], ["CC0402JRNPO9BN220", "22pF"], ["08055C104KAT2A", "100nF"],
            ["0603YC104KAT2A", "100nF"], ["ECJ-1VB1C105K", "1uF"],
        ];
        for (const [mpn, value] of cases) {
            expect([mpn, valueFromPartNumber(mpn)]).toEqual([mpn, value]);
        }
    });

    test("other parts have no value read from the part number", () => {
        for (const mpn of ["SN74LVC1G08DBVR", "STM32F103C8T6", "NE5532ADR", "1N4148W", "LM358", ""]) {
            expect([mpn, valueFromPartNumber(mpn)]).toEqual([mpn, ""]);
        }
    });

    test("label descriptions", () => {
        expect(valueFromDescription("RES 10K OHM 1% 1/8W 0805")).toBe("10k");
        expect(valueFromDescription("RES SMD 4.7 OHM 5% 1/10W 0603")).toBe("4.7R");
        expect(valueFromDescription("RES 1M OHM 1% 1/4W 1206")).toBe("1M");
        expect(valueFromDescription("CAP CER 0.1UF 50V X7R 0603")).toBe("100nF");
        expect(valueFromDescription("CAP CER 10000PF 50V X7R 0402")).toBe("10nF");
        expect(valueFromDescription("cap cer 4.7\u00b5f 25v")).toBe("4.7uF");
        expect(valueFromDescription("FIXED IND 10UH 1A 100 MOHM SMD")).toBe("10uH");
        expect(valueFromDescription("FIXED IND 1.5MH 200MA")).toBe("1.5mH");
        expect(valueFromDescription("IC GATE AND 1CH 2-INP SOT23-5")).toBe("");
    });

    test("ordering by size, other text after", () => {
        const sorted = ["10k", "1k", "R47", "100R", "4k7", "n/a", "2.2M"].sort(compareValues);
        expect(sorted).toEqual(["R47", "100R", "1k", "4k7", "10k", "2.2M", "n/a"]);
    });
});
