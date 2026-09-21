import { describe, expect, it } from "vitest";
import { assertDeliveryMode, deliveryModeOf, modeBadge } from "./delivery-mode.js";

describe("B-55 三态标识统一", () => {
  it("显式键与 archive.dataMode 均可识别；非法值不误判", () => {
    expect(deliveryModeOf({ delivery_mode: "live" })).toBe("live");
    expect(deliveryModeOf({ dataMode: "simulated" })).toBe("simulated");
    expect(deliveryModeOf({ archive: { dataMode: "mock" } })).toBe("mock");
    expect(deliveryModeOf({ mode: "production" })).toBeNull();
    expect(deliveryModeOf(null)).toBeNull();
  });

  it("缺失三态 → assert 抛错（不默认 mock）", () => {
    expect(() => assertDeliveryMode({}, "战报")).toThrow(/缺少三态标识/);
    expect(assertDeliveryMode({ mode: "live" }, "战报")).toBe("live");
  });

  it("角标文案与色调全端一致", () => {
    expect(modeBadge("live")).toEqual({ label: "真实数据（live）", tone: "go" });
    expect(modeBadge("simulated").tone).toBe("info");
    expect(modeBadge("mock").tone).toBe("warn");
  });
});
