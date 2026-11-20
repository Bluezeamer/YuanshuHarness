import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  applyFontSize,
  BASE_DEFAULT,
  CODE_RATIO,
  FONT_SIZE_KEY,
  loadFontSize,
  resolveFontSize,
} from "../../../app/fontSize";
import { UiFontSection } from "./UiFontSection";

// 根元素上的内联变量是全局状态，别让上一条用例的字号漏进下一条。
const rootVar = (name: string) =>
  document.documentElement.style.getPropertyValue(name);
const vars = () => [rootVar("--fs-read"), rootVar("--fs-code")];
const reset = () => {
  cleanup();
  localStorage.clear();
  document.documentElement.removeAttribute("style");
};

beforeEach(reset);
afterEach(reset);

const mount = () => render(<UiFontSection />);

const baseSlider = () => screen.getByRole("slider", { name: "基准字号滑块" });
const baseBox = () =>
  screen.getByRole("spinbutton", { name: "基准字号" }) as HTMLInputElement;
const tierBox = (name: string) =>
  screen.getByRole("spinbutton", { name }) as HTMLInputElement;
const dragBase = (value: number) =>
  fireEvent.change(baseSlider(), { target: { value: String(value) } });
const typeInto = (el: HTMLElement, value: string) => {
  fireEvent.change(el, { target: { value } });
  fireEvent.blur(el);
};
const openAdvanced = () =>
  fireEvent.click(screen.getByRole("button", { name: /进阶设置/ }));

test("默认 16px 基准：滑块与数字框同步，两档落到根元素", () => {
  // 先按 main.tsx 的两行落一次，模拟真实启动
  applyFontSize(loadFontSize());
  mount();
  expect((baseSlider() as HTMLInputElement).value).toBe(String(BASE_DEFAULT));
  expect(baseBox().value).toBe(String(BASE_DEFAULT));
  expect(vars()).toEqual([
    `${BASE_DEFAULT}px`,
    `${BASE_DEFAULT * CODE_RATIO}px`,
  ]);
});

test("拖滑块到 20：数字框跟着变，代码按比例推导并写进根元素", () => {
  mount();
  dragBase(20);
  expect(baseBox().value).toBe("20");
  // 20×0.875=17.5
  expect(vars()).toEqual(["20px", "17.5px"]);
  expect(JSON.parse(localStorage.getItem(FONT_SIZE_KEY) ?? "{}")).toMatchObject(
    {
      base: 20,
    },
  );
});

test("在数字框里输入：滑块跟着走，失焦才提交一次", () => {
  mount();
  typeInto(baseBox(), "18");
  expect((baseSlider() as HTMLInputElement).value).toBe("18");
  expect(vars()[0]).toBe("18px");
});

test("数字框超出范围时夹到上下限，粘不上非法值", () => {
  mount();
  typeInto(baseBox(), "99");
  expect(baseBox().value).toBe("22");
  expect(vars()[0]).toBe("22px");
});

test("进阶：把代码档钉在 20，之后改基准只动正文", () => {
  mount();
  openAdvanced();
  typeInto(tierBox("代码"), "20");
  expect(vars()[1]).toBe("20px");

  dragBase(18);
  expect(vars()).toEqual(["18px", "20px"]);
  expect(localStorage.getItem(FONT_SIZE_KEY)).toContain('"code":20');
});

test("进阶：点「恢复跟随」后代码档回到基准推导的值", () => {
  mount();
  openAdvanced();
  typeInto(tierBox("代码"), "20");
  fireEvent.click(screen.getByRole("button", { name: "代码恢复跟随基准" }));
  expect(vars()[1]).toBe(`${BASE_DEFAULT * CODE_RATIO}px`);
  expect(tierBox("代码").value).toBe(String(BASE_DEFAULT * CODE_RATIO));
});

test("进阶：跟随时「恢复跟随」禁用，改基准会让两档一起动", () => {
  mount();
  openAdvanced();
  const follow = screen.getByRole("button", {
    name: "正文恢复跟随基准",
  }) as HTMLButtonElement;
  expect(follow.disabled).toBe(true);
  dragBase(22);
  expect(tierBox("正文").value).toBe("22");
  expect(tierBox("代码").value).toBe("19.5");
});

test("刷新后仍生效：重新挂载时读回存储里的基准与覆盖值", () => {
  mount();
  openAdvanced();
  dragBase(20);
  typeInto(tierBox("代码"), "16");
  // 模拟刷新：内联变量随旧文档一起没了，只剩 localStorage
  cleanup();
  document.documentElement.removeAttribute("style");
  mount();
  expect(baseBox().value).toBe("20");
  openAdvanced();
  expect(tierBox("代码").value).toBe("16");
});

test("存储里是上一版的档位枚举（lg 这类）：解析不出来就回默认，不抛错", () => {
  localStorage.setItem(FONT_SIZE_KEY, "lg");
  mount();
  expect(baseBox().value).toBe(String(BASE_DEFAULT));
});

test("示例预览块在：正文 / 代码两段随设置显示当前像素值", () => {
  mount();
  dragBase(20);
  const pv = screen.getByLabelText("字号预览");
  expect(within(pv).getByText(/正文 · 20px/)).toBeTruthy();
  expect(within(pv).getByText(/代码 · 17\.5px/)).toBeTruthy();
  // 预览里确实有一段示例代码
  expect(within(pv).getByText(/const code = base \* 0\.875/)).toBeTruthy();
});

test("推导规则自洽：正文随基准，覆盖值优先，代码比正文小一档", () => {
  const plain = resolveFontSize({ base: 16, read: null, code: null });
  expect(plain).toEqual({ read: 16, code: 14 });
  const over = resolveFontSize({ base: 20, read: 24, code: null });
  expect(over).toEqual({ read: 24, code: 17.5 });
  expect(CODE_RATIO).toBeLessThan(1);
});

test("基准字号：默认值写在说明里；改过后「恢复默认」回到默认并写进根元素，已是默认时禁用", () => {
  mount();
  const reset = () => screen.getByRole("button", { name: "恢复默认" });
  expect(screen.getByText(new RegExp(`默认 ${BASE_DEFAULT}px`))).toBeTruthy();
  expect((reset() as HTMLButtonElement).disabled).toBe(true);
  dragBase(20);
  expect((reset() as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(reset());
  expect(baseBox().value).toBe(String(BASE_DEFAULT));
  expect(vars()[0]).toBe(`${BASE_DEFAULT}px`);
  expect((reset() as HTMLButtonElement).disabled).toBe(true);
});
