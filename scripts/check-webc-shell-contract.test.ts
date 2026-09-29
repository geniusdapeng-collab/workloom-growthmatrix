/**
 * C 端壳布局契约（MC-012 · 静态门禁）。
 *
 * 真机几何由 `scripts/check-shell-layout.mjs` 量测（需要浏览器，非 CI 阻断）；
 * 本测试锁定**根因**不在静态层面复发：
 *
 *  ① `apps/webc/src/styles/tokens.css#.phone-shell` 不得声明 `display` / `flex-direction`——
 *     共享壳 `.wl-app-shell{display:grid; grid-template-rows:auto minmax(0,1fr) auto}` 才是三段式
 *     （顶栏 / 主区 / 底栏贴底）的唯一事实源；同特异性覆盖会让底栏回到普通文档流（实测停在 y=391）。
 *  ② `.phone-shell` 仍须给出 `height` / `min-height`（视口高度来源），否则 grid 行高没有确定高度。
 *  ③ `apps/webc/src/App.tsx` 仍把 `.phone-shell` 挂在共享 `AppShell` 上（规则不落空）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(__dirname, "..");
const TOKENS = readFileSync(join(REPO_ROOT, "apps/webc/src/styles/tokens.css"), "utf8");
const APP = readFileSync(join(REPO_ROOT, "apps/webc/src/App.tsx"), "utf8");

/** 取出某个类选择器的规则体（单层花括号足够；本文件不含嵌套规则） */
function ruleBody(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`未找到规则 ${selector}`);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close);
}

describe("C 端壳布局契约（.phone-shell 不得覆盖共享壳 grid）", () => {
  const body = ruleBody(TOKENS, ".phone-shell");

  it("不声明 display，避免覆盖共享壳的 grid 三段式", () => {
    expect(body).not.toMatch(/(?:^|[;\s])display\s*:/);
  });

  it("不声明 flex 相关布局属性", () => {
    expect(body).not.toMatch(/(?:^|[;\s])flex(?:-direction|-wrap|-flow|-grow|-basis)?\s*:/);
  });

  it("保留视口高度来源（height + min-height）", () => {
    expect(body).toMatch(/(?:^|[;\s])height\s*:\s*var\(--app-height/);
    expect(body).toMatch(/(?:^|[;\s])min-height\s*:\s*var\(--app-height/);
  });

  it("共享 AppShell 仍被挂上手机壳类名（契约不落空）", () => {
    expect(APP).toMatch(/className="phone-shell"/);
  });
});
