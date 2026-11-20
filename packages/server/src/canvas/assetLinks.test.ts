import { expect, test } from "vitest";
import { encodeLinkSeg, rewriteAssetLinks } from "./assetLinks.js";

test("链接地址转义：空格、括号、百分号等，中文原样", () => {
  expect(encodeLinkSeg("我的 图(1).assets")).toBe("我的%20图%281%29.assets");
  expect(encodeLinkSeg("100%")).toBe("100%25");
});

test("改名后指向旧资源夹的链接改到新资源夹（图片与普通链接都改，./ 保留，文件名部分原样）", () => {
  const text = [
    "![](./.assets/访谈/a%20b.png)",
    "[附件](.assets/访谈/x.pdf)",
    "![](./.assets/访谈/_large/big.png)",
  ].join("\n");
  expect(rewriteAssetLinks(text, "访谈", "新 名")).toBe(
    [
      "![](./.assets/新%20名/a%20b.png)",
      "[附件](.assets/新%20名/x.pdf)",
      "![](./.assets/新%20名/_large/big.png)",
    ].join("\n"),
  );
});

test("编码过的旧名也认；别的笔记的资源夹、外链、别处的 .assets、没有文件名的不动", () => {
  expect(
    rewriteAssetLinks("![](./.assets/访谈%20一/a.png)", "访谈 一", "x"),
  ).toBe("![](./.assets/x/a.png)");
  const same = [
    "![](./.assets/别的/a.png)",
    "![](https://example.com/.assets/访谈/a.png)",
    "![](../.assets/访谈/a.png)",
    "![](./.assets/访谈)",
    "![](./访谈.assets/a.png)",
  ].join("\n");
  expect(rewriteAssetLinks(same, "访谈", "x")).toBe(same);
});
