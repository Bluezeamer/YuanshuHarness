import { expect, test } from "vitest";
import { testData } from "../../test/support/stub.js";
import {
  CANVAS_MEDIA_DEFAULT,
  DEFAULT_DIRECTORY_START,
  DefaultsStore,
  IMAGE_COMPRESSION_LIMITS,
  isBrowserMirror,
  isCanvasMedia,
  isImageCompression,
  PI_IMAGE_COMPRESSION,
} from "./defaults.js";

test("空库：返回默认值（目录起点 ~、压缩参数与 pi 默认一致）", () => {
  const data = testData();
  try {
    const defaults = new DefaultsStore(data.db);
    expect(defaults.get()).toEqual({
      directoryStart: DEFAULT_DIRECTORY_START,
      imageCompression: PI_IMAGE_COMPRESSION,
      permissionTier: "rules",
      reviewModel: null,
      auxModel: null,
      jobRemindSeconds: 600,
      goalMaxRounds: 50,
      subagentLimits: { maxDepth: 3, perCaller: 10, perTree: 50 },
      canvasMedia: CANVAS_MEDIA_DEFAULT,
      browserMirror: "",
    });
    expect(PI_IMAGE_COMPRESSION).toMatchObject({
      enabled: true,
      maxWidth: 2000,
      maxHeight: 2000,
      maxBytes: 4.5 * 1024 * 1024,
      jpegQuality: 80,
    });
  } finally {
    data.close();
  }
});

test("写入后读回；只改目录起点不影响压缩设置", () => {
  const data = testData();
  try {
    const defaults = new DefaultsStore(data.db);
    defaults.setDirectoryStart("/srv");
    defaults.setImageCompression({
      ...PI_IMAGE_COMPRESSION,
      enabled: false,
      maxWidth: 800,
    });
    expect(defaults.directoryStart()).toBe("/srv");
    expect(defaults.imageCompression()).toEqual({
      ...PI_IMAGE_COMPRESSION,
      enabled: false,
      maxWidth: 800,
    });
    defaults.setDirectoryStart("~/code");
    expect(defaults.imageCompression().enabled).toBe(false);
  } finally {
    data.close();
  }
});

test("库里是坏数据（非法 JSON / 越界值）时回退默认值", () => {
  const data = testData();
  try {
    const defaults = new DefaultsStore(data.db);
    const put = (value: string) =>
      data.db
        .prepare(
          "INSERT INTO meta (key, value) VALUES ('default_image_compression', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .run(value);
    put("{not json");
    expect(defaults.imageCompression()).toEqual(PI_IMAGE_COMPRESSION);
    put(JSON.stringify({ ...PI_IMAGE_COMPRESSION, maxWidth: 99999 }));
    expect(defaults.imageCompression()).toEqual(PI_IMAGE_COMPRESSION);
  } finally {
    data.close();
  }
});

test("isImageCompression：字段齐全、整数且在范围内才算合法", () => {
  expect(isImageCompression(PI_IMAGE_COMPRESSION)).toBe(true);
  expect(isImageCompression({ ...PI_IMAGE_COMPRESSION, enabled: "yes" })).toBe(
    false,
  );
  expect(isImageCompression({ ...PI_IMAGE_COMPRESSION, maxWidth: 1.5 })).toBe(
    false,
  );
  expect(isImageCompression({ ...PI_IMAGE_COMPRESSION, maxWidth: 255 })).toBe(
    false,
  );
  expect(
    isImageCompression({
      ...PI_IMAGE_COMPRESSION,
      maxWidth: IMAGE_COMPRESSION_LIMITS.maxWidth.max + 1,
    }),
  ).toBe(false);
  expect(isImageCompression({ ...PI_IMAGE_COMPRESSION, maxBytes: 0 })).toBe(
    false,
  );
  expect(
    isImageCompression({ ...PI_IMAGE_COMPRESSION, jpegQuality: 101 }),
  ).toBe(false);
  const { jpegQuality: _drop, ...missing } = PI_IMAGE_COMPRESSION;
  expect(isImageCompression(missing)).toBe(false);
  expect(isImageCompression(null)).toBe(false);
  expect(isImageCompression([])).toBe(false);
});

test("画布媒体设置：读写、越界与残缺的当成没配（回缺省）", () => {
  const data = testData();
  try {
    const defaults = new DefaultsStore(data.db);
    expect(defaults.canvasMedia()).toEqual(CANVAS_MEDIA_DEFAULT);
    const mine = { ...CANVAS_MEDIA_DEFAULT, thumbMaxSide: 1200, gifMaxMB: 30 };
    defaults.setCanvasMedia(mine);
    expect(defaults.canvasMedia()).toEqual(mine);
    expect(isCanvasMedia(mine)).toBe(true);
    for (const bad of [
      { ...mine, thumbMaxSide: 100 },
      { ...mine, thumbQuality: 101 },
      { ...mine, gifMaxMB: 0 },
      { ...mine, uploadMaxMB: 1.5 },
      { ...mine, assetGitMaxMB: "5" },
      { thumbMaxSide: 1200 },
      null,
    ])
      expect(isCanvasMedia(bad)).toBe(false);
    // 库里存了残缺或越界的值：读出来是缺省，不抛
    data.db
      .prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")
      .run("canvas_media", JSON.stringify({ thumbMaxSide: 5 }));
    expect(defaults.canvasMedia()).toEqual(CANVAS_MEDIA_DEFAULT);
  } finally {
    data.close();
  }
});

test("审核判别准则：默认 null；存取；null 清除；不出现在 get() 里", () => {
  const data = testData();
  try {
    const defaults = new DefaultsStore(data.db);
    expect(defaults.reviewCriteria()).toBeNull();
    defaults.setReviewCriteria("只许改 docs");
    expect(defaults.reviewCriteria()).toBe("只许改 docs");
    // 单独一条接口管它，不混进全局默认值的字段里
    expect(defaults.get()).not.toHaveProperty("reviewCriteria");
    defaults.setReviewCriteria(null);
    expect(defaults.reviewCriteria()).toBeNull();
    expect(
      data.db.prepare("SELECT 1 FROM meta WHERE key = 'review_criteria'").get(),
    ).toBeUndefined();
  } finally {
    data.close();
  }
});

test("浏览器下载镜像：读写；只认空串或 http(s) 地址，库里存了坏值读出来是空", () => {
  const data = testData();
  try {
    const defaults = new DefaultsStore(data.db);
    expect(defaults.browserMirror()).toBe("");
    defaults.setBrowserMirror("https://mirror.example/playwright");
    expect(defaults.browserMirror()).toBe("https://mirror.example/playwright");
    expect(defaults.get().browserMirror).toBe(
      "https://mirror.example/playwright",
    );
    for (const ok of ["", "http://10.0.0.2:8080/pw", "https://a.b/c"])
      expect(isBrowserMirror(ok), ok).toBe(true);
    for (const bad of [
      "mirror.example",
      "ftp://a.b/c",
      "javascript:alert(1)",
      `https://a.b/${"x".repeat(600)}`,
      null,
      3,
    ])
      expect(isBrowserMirror(bad), String(bad)).toBe(false);
    data.db
      .prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")
      .run("browser_mirror", "not a url");
    expect(defaults.browserMirror()).toBe("");
  } finally {
    data.close();
  }
});
