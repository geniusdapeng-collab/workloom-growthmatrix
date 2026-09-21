/**
 * B-80 价格与权益确认单 + 预售券/退改合规模板测试（第一批 §8.4 / DEC-06）。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

const hotelDir = join(import.meta.dirname, "..", "..", "..", "bundles", "hotel");
const read = (p: string) => readFileSync(join(hotelDir, p), "utf8");
const preset = (key: string) => YAML.parse(read(`presets/${key}.yml`)) as {
  fence_bindings: string[];
  tools: Array<{ name: string; access: string }>;
  write_back?: string[];
};

describe("B-80 价格与权益确认单", () => {
  it("确认单模板存在且含明码标价/划线价依据/退改/责任/客户确认", () => {
    const text = read("library/templates/price-rights-confirmation.md");
    for (const clause of ["明码标价", "划线价", "到手价", "不得虚构原价", "退改规则", "责任划分", "客户确认"]) {
      expect(text, `确认单缺条款：${clause}`).toContain(clause);
    }
  });

  it("预售券条款含券面价/有效期/退改/超卖处理，且引用 R22/R26 合规自检", () => {
    const text = read("library/templates/presale-coupon-terms.md");
    for (const clause of ["券面价", "使用有效期", "退改与退款", "库存不足即停售", "R26", "R22"]) {
      expect(text, `预售券条款缺：${clause}`).toContain(clause);
    }
  });

  it("退改说明含阶梯/不可抗力/未到店/责任与凭证", () => {
    const text = read("library/templates/refund-change-policy.md");
    for (const clause of ["退改阶梯", "不可抗力", "no-show", "责任划分", "退款时效"]) {
      expect(text, `退改说明缺：${clause}`).toContain(clause);
    }
  });

  it("确认单工具落在定价岗（写工具 + R25/R2 围栏 + write_back）", () => {
    const p = preset("pricing-agent");
    expect(p.tools.some((t) => t.name === "price.confirmation.issue" && t.access === "write")).toBe(true);
    expect(p.fence_bindings).toEqual(expect.arrayContaining(["R2", "R25"]));
    expect(p.write_back).toContain("price.confirmation.issue");
  });

  it("券条款工具落在团购岗（写工具 + R22/R26/R25 围栏）", () => {
    const p = preset("coupon-operator");
    expect(p.tools.some((t) => t.name === "coupon.terms.render" && t.access === "write")).toBe(true);
    expect(p.fence_bindings).toEqual(expect.arrayContaining(["R22", "R26", "R25"]));
  });

  it("价格确认单对象与模板清单都在 hotel 清单声明且文件存在", () => {
    const objects = JSON.parse(read("schemas/objects.json")) as { objects: Array<{ type: string }> };
    expect(objects.objects.some((o) => o.type === "price_confirmation")).toBe(true);
    const manifest = JSON.parse(read("bundle.json")) as { workloom: { provides: { library: string[] } } };
    const templates = [
      "library/templates/price-rights-confirmation.md",
      "library/templates/presale-coupon-terms.md",
      "library/templates/refund-change-policy.md",
    ];
    expect(manifest.workloom.provides.library).toEqual(expect.arrayContaining(templates));
    expect(templates.every((t) => existsSync(join(hotelDir, t)))).toBe(true);
  });
});
