/**
 * B-19 OTA 上传包测试：三通道就绪分级、三类素材预检、未配置 fail-closed、上传与审核状态回写。
 */
import { describe, expect, it, vi } from "vitest";
import { createOtaAdapter, createOtaAdapters, otaReadiness } from "./adapters.js";
import type { OtaAsset } from "./types.js";

const MB = 1024 * 1024;
const asset = (over: Partial<OtaAsset> = {}): OtaAsset => ({
  id: "ota-a1", channel: "ctrip", kind: "room_photo", propertyId: "hotel-1", roomTypeId: "rt-1",
  filePath: "/tmp/room.jpg", caption: "行政大床房", order: 0, bytes: 2 * MB, mimeType: "image/jpeg",
  ...over,
});

const READY_ENV = {
  CTRIP_OTA_URL: "https://ctrip.example/api", CTRIP_OTA_TOKEN: "t-ctrip",
  MEITUAN_OTA_URL: "https://meituan.example/api", MEITUAN_OTA_TOKEN: "t-meituan",
  FLIGGY_OTA_URL: "https://fliggy.example/api", FLIGGY_OTA_TOKEN: "t-fliggy",
};

describe("B-19 通道与素材契约", () => {
  it("三通道（携程/美团/飞猪）与三类素材（房型图/相册/视频）", () => {
    const adapters = createOtaAdapters();
    expect(adapters.map((a) => a.spec.channel)).toEqual(["ctrip", "meituan", "fliggy"]);
    expect(adapters.find((a) => a.spec.channel === "ctrip")!.spec.supportedKinds).toEqual(["room_photo", "album", "video"]);
    expect(adapters.find((a) => a.spec.channel === "meituan")!.spec.supportedKinds).toEqual(["room_photo", "album"]);
  });

  it("就绪分级：凭证齐 → ready；缺 → unconfigured 并列出缺失键", () => {
    const configured = otaReadiness({ env: READY_ENV });
    expect(configured.every((r) => r.state === "ready")).toBe(true);
    const missing = otaReadiness({ env: {} });
    expect(missing.every((r) => r.state === "unconfigured")).toBe(true);
    expect(missing[0]!.detail).toContain("CTRIP_OTA_URL");
  });
});

describe("B-19 预检（纯函数）", () => {
  it("素材类型不受支持 / 体积超限 / 相册序位越界 → 直接拒", () => {
    const meituan = createOtaAdapter("meituan");
    expect(meituan.preflight(asset({ channel: "meituan", kind: "video" })).reasons.join("；")).toContain("不支持素材类型 video");
    const ctrip = createOtaAdapter("ctrip");
    expect(ctrip.preflight(asset({ bytes: 11 * MB })).reasons.join("；")).toContain("超上限 10MB");
    expect(ctrip.preflight(asset({ kind: "album", order: 999 })).reasons.join("；")).toContain("相册序位");
  });
});

describe("B-19 上传与审核状态回写（fail-closed）", () => {
  it("未配置凭证：upload 返回 unknown + synced=false，且不发起任何请求", async () => {
    const fetchImpl = vi.fn();
    const adapter = createOtaAdapter("fliggy");
    const receipt = await adapter.upload(asset({ channel: "fliggy" }), { env: {}, fetchImpl: fetchImpl as never });
    expect(receipt).toMatchObject({ channel: "fliggy", status: "unknown", synced: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("配置凭证：上传带 Bearer 与素材体，pending 审核状态如实回写", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ asset_id: "ctrip-777", status: "pending" }), { status: 200 }));
    const adapter = createOtaAdapter("ctrip");
    const receipt = await adapter.upload(asset(), { env: READY_ENV, fetchImpl: fetchImpl as never });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://ctrip.example/api/assets");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer t-ctrip");
    expect(receipt).toMatchObject({ platformAssetId: "ctrip-777", status: "pending_review", synced: true });
  });

  it("回执探测：approved/rejected 视为已核实，unknown 不核实", async () => {
    const approved = createOtaAdapter("ctrip");
    const r1 = await approved.probeReceipt("ctrip-777", {
      env: READY_ENV,
      fetchImpl: (async () => new Response(JSON.stringify({ status: "approved" }), { status: 200 })) as never,
    });
    expect(r1).toMatchObject({ status: "approved", synced: true });
    const rejected = await approved.probeReceipt("ctrip-778", {
      env: READY_ENV,
      fetchImpl: (async () => new Response(JSON.stringify({ status: "rejected", reason: "含联系方式水印" }), { status: 200 })) as never,
    });
    expect(rejected).toMatchObject({ status: "rejected", synced: true, rejectReason: "含联系方式水印" });
    const unknown = await approved.probeReceipt("ctrip-779", { env: {} });
    expect(unknown.synced).toBe(false);
  });
});
