// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import P0 from "./P0";

const fake = vi.hoisted(() => ({ query: vi.fn(), login: vi.fn(), initialize: vi.fn(), save: vi.fn() }));
vi.mock("../../lib/trpc", () => ({ ensureDemoLogin: fake.login, isLocalFull: () => true,
  trpc: { captain: { theater: { query: fake.query } }, onboarding: {
    status: { query: async () => ({ workspace: { name: "隔离回归工作区" } }) },
    welcomeStatus: { query: async () => ({ status: "paused", shouldShow: false }) },
  } } }));
vi.mock("../../shell/NavigationAccess", () => ({ useNavigationAccess: () => ({ bundle: null, entries: [], subject: null, canAction: () => false }) }));
vi.mock("react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../../onboarding/useWelcomeProgress", () => ({ useWelcomeProgress: () => ({ welcome: null, initialize: fake.initialize, save: fake.save }) }));
vi.mock("../../onboarding/useQuestline", () => ({ useQuestline: () => ({ summary: "", level: 1, xp: 0, state: { achievements: [], status: "paused" } }) }));
vi.mock("../../onboarding/questline.config", () => ({ questlineForBundle: () => null }));
vi.mock("../../lib/theaterDiff", () => ({ useTheaterDiff: () => null }));
vi.mock("../../voice/VoiceEngine", () => ({ VoiceEngine: { speak: vi.fn() } }));
vi.mock("../../audio/AudioEngine", () => ({ AudioEngine: { bindGesture: vi.fn(), play: vi.fn() } }));
vi.mock("../../audio/ambience", () => ({ useAmbience: () => undefined }));
vi.mock("../../components/CommandCard", () => ({ CommandCard: () => null }));
vi.mock("../../components/SimBanner", () => ({ SimBanner: () => null }));
vi.mock("../../components/SkillDistBanner", () => ({ SkillDistBanner: () => null }));
vi.mock("../../components/Stage3D", () => ({ Stage3D: () => null }));
vi.mock("../../components/Floor3D", () => ({ Floor3D: () => null }));
vi.mock("./Floor", () => ({ FloorView: () => null }));
vi.mock("../../components/WelcomeCeremony", () => ({ WelcomeCeremony: () => null }));
vi.mock("../../components/ValueCounters", () => ({ ValueCounters: () => null }));
vi.mock("../../components/mate-guide/QuestlineHud", () => ({ QuestlineHud: () => null }));
vi.mock("../../components/mate-guide/QuestlineGuide", () => ({ QuestlineGuide: () => null }));
vi.mock("../../onboarding/QuestlineContent", () => ({ QuestlineContentProvider: () => null }));

const theater = { mode: "active", ceoName: "公司负责人", pendingByTier: {}, latestBriefing: null, satellites: [], ticker: [] };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe("经营主页加载失败与恢复", () => {
  let host: HTMLDivElement;
  let root: Root | null;
  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers(); localStorage.clear();
    fake.query.mockReset(); fake.login.mockReset().mockResolvedValue(undefined);
    fake.initialize.mockReset(); fake.save.mockReset();
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(type => type === "2d" ? {
      clearRect: vi.fn(), beginPath: vi.fn(), arc: vi.fn(), fill: vi.fn(), fillStyle: "",
    } as unknown as CanvasRenderingContext2D : null);
    host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => { root?.unmount(); root = null; });
    host.remove(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  });
  async function render() { await act(async () => root!.render(<P0 />)); }
  const ready = () => host.querySelector("[data-product-ready]")?.getAttribute("data-product-ready");

  it("首次请求失败显示可重试错误，计时器不能把失败页演成全员就位", async () => {
    fake.query.mockRejectedValue(new Error("request failed: private internal connection"));
    await render(); await act(async () => vi.advanceTimersByTime(10_000));
    expect(ready()).toBe("false");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("经营实况暂时无法加载");
    expect(host.textContent).not.toContain("private internal connection");
    expect(host.textContent).not.toContain("团队全员就位");
    expect(localStorage.getItem(`theater-ceremony-${new Date().toDateString()}`)).toBeNull();
    expect(host.querySelector("button[data-retry-theater]")).not.toBeNull();
  });

  it("重试成功后才更新实况并启动仪式，错误提示随恢复清除", async () => {
    fake.query.mockRejectedValueOnce(new Error("offline")).mockResolvedValue(theater);
    await render();
    await act(async () => host.querySelector<HTMLButtonElement>("button[data-retry-theater]")!.click());
    expect(ready()).toBe("true"); expect(host.querySelector('[role="alert"]')).toBeNull();
    await act(async () => vi.advanceTimersByTime(4300));
    expect(localStorage.getItem(`theater-ceremony-${new Date().toDateString()}`)).toBe("1");
  });

  it("轮询失败保留上次画面并明确标记旧实况，恢复后重新就绪", async () => {
    fake.query.mockResolvedValueOnce(theater).mockRejectedValueOnce(new Error("offline")).mockResolvedValue(theater);
    await render(); expect(ready()).toBe("true");
    await act(async () => vi.advanceTimersByTime(5100));
    expect(ready()).toBe("false");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("保留上次实况");
    expect(host.textContent).toContain("公司负责人");
    await act(async () => vi.advanceTimersByTime(5100));
    expect(ready()).toBe("true"); expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it("慢请求期间显示加载态，不因多个轮询重入；卸载后响应不触发新请求", async () => {
    const pending = deferred<typeof theater>(); fake.query.mockReturnValue(pending.promise);
    await render();
    expect(host.querySelector('[role="status"]')?.textContent).toContain("正在加载经营实况");
    await act(async () => vi.advanceTimersByTime(16_000));
    expect(fake.query).toHaveBeenCalledTimes(1);
    await act(async () => { root!.unmount(); root = null; pending.resolve(theater); });
    await act(async () => vi.advanceTimersByTime(10_000));
    expect(fake.query).toHaveBeenCalledTimes(1);
  });

  it("登录失败也进入同一错误态，不能留下未处理的异步异常", async () => {
    fake.login.mockRejectedValue(new Error("未认证"));
    await render();
    expect(fake.query).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("登录状态已失效");
    expect(ready()).toBe("false");
  });
});
