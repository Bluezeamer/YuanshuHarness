import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, expect, test } from "vitest";
import { type TestData, testData } from "../../test/support/stub.js";
import type { ModelResolver } from "../provider/resolve.js";
import {
  CANVAS_MEDIA_DEFAULT,
  type Defaults,
  DefaultsStore,
  PI_IMAGE_COMPRESSION,
} from "../store/defaults.js";
import { defaultsApi } from "./defaults.js";

// 只认 prov/m1 一个模型：审批模型的校验只用到 has。
const resolver = {
  has: (p: string, m: string) => p === "prov" && m === "m1",
} as ModelResolver;

const BASE = {
  directoryStart: "~",
  imageCompression: PI_IMAGE_COMPRESSION,
  permissionTier: "rules",
  reviewModel: null,
  auxModel: null,
  jobRemindSeconds: 600,
  goalMaxRounds: 50,
  subagentLimits: { maxDepth: 3, perCaller: 10, perTree: 50 },
  canvasMedia: CANVAS_MEDIA_DEFAULT,
  browserMirror: "",
};

let data: TestData | undefined;
let app: FastifyInstance | undefined;

async function boot() {
  data = testData();
  app = Fastify({ logger: false });
  await app.register(defaultsApi, {
    defaults: new DefaultsStore(data.db),
    resolver,
  });
  await app.ready();
}

afterEach(async () => {
  await app?.close();
  data?.close();
  data = undefined;
  app = undefined;
});

const server = (): FastifyInstance => {
  if (!app) throw new Error("未启动测试服务");
  return app;
};

const get = async (): Promise<Defaults> => {
  const res = await server().inject({
    method: "GET",
    url: "/api/v1/defaults",
  });
  expect(res.statusCode).toBe(200);
  return res.json() as Defaults;
};

// 用字符串 payload：null / 数组 / 原始值都能原样送进服务端。
const put = async (body: unknown) =>
  server().inject({
    method: "PUT",
    url: "/api/v1/defaults",
    payload: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });

test("GET：没人设置过时给默认值（含图片压缩=pi 默认）", async () => {
  await boot();
  expect(await get()).toEqual(BASE);
});

test("PUT 支持按字段更新：只改目录起点，压缩设置保留", async () => {
  await boot();
  const res = await put({ directoryStart: " /srv " });
  expect(res.statusCode).toBe(200);
  expect(await get()).toEqual({ ...BASE, directoryStart: "/srv" });

  const custom = {
    ...PI_IMAGE_COMPRESSION,
    enabled: false,
    maxWidth: 1024,
    maxHeight: 768,
    maxBytes: 2 * 1024 * 1024,
    jpegQuality: 60,
  };
  expect((await put({ imageCompression: custom }))?.statusCode).toBe(200);
  expect(await get()).toEqual({
    ...BASE,
    directoryStart: "/srv",
    imageCompression: custom,
  });
  // 再改起点不会覆盖压缩设置
  await put({ directoryStart: "~/code" });
  expect((await get()).imageCompression).toEqual(custom);
});

test("PUT 校验：起点与压缩参数不合法都拒绝且不落库", async () => {
  await boot();
  for (const v of ["", "  ", 5, "a\0b", "x".repeat(4097)]) {
    const res = await put({ directoryStart: v });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid_directory_start" });
  }
  const badCompression = [
    null,
    [],
    "x",
    { ...PI_IMAGE_COMPRESSION, enabled: 1 },
    { ...PI_IMAGE_COMPRESSION, maxWidth: 100 },
    { ...PI_IMAGE_COMPRESSION, maxWidth: 2001 },
    { ...PI_IMAGE_COMPRESSION, maxHeight: 1.5 },
    { ...PI_IMAGE_COMPRESSION, maxBytes: 1024 },
    { ...PI_IMAGE_COMPRESSION, maxBytes: 5 * 1024 * 1024 },
    { ...PI_IMAGE_COMPRESSION, jpegQuality: 0 },
    { ...PI_IMAGE_COMPRESSION, jpegQuality: 101 },
    { enabled: true },
  ];
  for (const imageCompression of badCompression) {
    const res = await put({ imageCompression });
    expect(res.statusCode, JSON.stringify(imageCompression)).toBe(400);
    expect(res.json()).toEqual({ error: "invalid_image_compression" });
  }
  expect((await put({}))?.statusCode).toBe(400);
  expect((await put(null))?.statusCode).toBe(400);
  expect(await get()).toEqual(BASE);
});

const REVIEW = { provider: "prov", model: "m1", thinking: null };

test("审批模型与默认档位：「模型」档要先有审批模型，一并给也算", async () => {
  await boot();
  expect((await put({ permissionTier: "bogus" })).json()).toEqual({
    error: "invalid_permission_tier",
  });
  const noModel = await put({ permissionTier: "auto" });
  expect(noModel.statusCode).toBe(400);
  expect(noModel.json()).toEqual({ error: "review_model_missing" });
  expect((await get()).permissionTier).toBe("rules");

  expect(
    (await put({ permissionTier: "auto", reviewModel: REVIEW })).statusCode,
  ).toBe(200);
  expect(await get()).toEqual({
    ...BASE,
    permissionTier: "auto",
    reviewModel: REVIEW,
  });
  // 只改档位不动审批模型；改回 full 后清掉审批模型
  await put({ permissionTier: "full" });
  expect((await get()).reviewModel).toEqual(REVIEW);
  await put({ reviewModel: null });
  expect(await get()).toEqual({ ...BASE, permissionTier: "full" });
});

test("审批模型校验：未登记的模型 404，缺字段与非法思考强度 400", async () => {
  await boot();
  expect(
    (await put({ reviewModel: { provider: "prov", model: "nope" } }))
      .statusCode,
  ).toBe(404);
  for (const reviewModel of ["x", {}, { provider: "prov" }])
    expect((await put({ reviewModel })).statusCode).toBe(400);
  expect(
    (await put({ reviewModel: { ...REVIEW, thinking: "bogus" } })).json(),
  ).toEqual({ error: "invalid_thinking" });
  expect((await get()).reviewModel).toBeNull();
});

test("辅助模型：选法与审批模型一致，与审批模型各自独立；清除回到「用会话自己的模型」", async () => {
  await boot();
  expect(
    (await put({ auxModel: { provider: "prov", model: "nope" } })).statusCode,
  ).toBe(404);
  for (const auxModel of ["x", {}, { provider: "prov" }])
    expect((await put({ auxModel })).json()).toEqual({
      error: "invalid_aux_model",
    });
  expect(
    (await put({ auxModel: { ...REVIEW, thinking: "bogus" } })).json(),
  ).toEqual({ error: "invalid_thinking" });
  expect((await get()).auxModel).toBeNull();

  expect((await put({ auxModel: REVIEW })).statusCode).toBe(200);
  expect(await get()).toEqual({ ...BASE, auxModel: REVIEW });
  await put({ reviewModel: REVIEW });
  await put({ auxModel: null });
  expect(await get()).toEqual({ ...BASE, reviewModel: REVIEW });
});

test("后台任务提醒与子代理限额：可改、非法被拒且不落库", async () => {
  await boot();
  expect((await put({ jobRemindSeconds: 300 })).statusCode).toBe(200);
  expect((await get()).jobRemindSeconds).toBe(300);
  for (const bad of [5, 90_000, 12.5, "10"])
    expect((await put({ jobRemindSeconds: bad })).statusCode).toBe(400);
  expect((await get()).jobRemindSeconds).toBe(300);

  const limits = { maxDepth: 2, perCaller: 5, perTree: 20 };
  expect((await put({ subagentLimits: limits })).statusCode).toBe(200);
  expect((await get()).subagentLimits).toEqual(limits);
  for (const bad of [
    { ...limits, maxDepth: 0 },
    { ...limits, perTree: 1000 },
    { maxDepth: 2, perCaller: 5 },
    "x",
  ])
    expect((await put({ subagentLimits: bad })).statusCode).toBe(400);
  expect((await get()).subagentLimits).toEqual(limits);
});

test("目标轮数上限：正数或 null（不限）都可写，其余 400 且不落库", async () => {
  await boot();
  expect((await put({ goalMaxRounds: 20 })).statusCode).toBe(200);
  expect((await get()).goalMaxRounds).toBe(20);
  // null 是有效值：改成不限，且不出现在校验错误里
  expect((await put({ goalMaxRounds: null })).statusCode).toBe(200);
  expect((await get()).goalMaxRounds).toBeNull();
  for (const bad of [0, -1, 10_001, 2.5, "10", true])
    expect((await put({ goalMaxRounds: bad })).statusCode).toBe(400);
  expect((await get()).goalMaxRounds).toBeNull();
});

test("PUT 画布媒体设置：整份校验，局部更新不影响别的字段，非法 400 且不落库", async () => {
  await boot();
  const media = { ...CANVAS_MEDIA_DEFAULT, thumbMaxSide: 1600, gifMaxMB: 40 };
  expect((await put({ canvasMedia: media })).statusCode).toBe(200);
  expect((await get()).canvasMedia).toEqual(media);
  expect((await put({ jobRemindSeconds: 300 })).statusCode).toBe(200);
  expect((await get()).canvasMedia).toEqual(media);
  for (const bad of [
    { ...media, thumbMaxSide: 10 },
    { ...media, thumbQuality: 0 },
    { ...media, uploadMaxMB: 99999 },
    { thumbMaxSide: 1600 },
    "x",
  ])
    expect((await put({ canvasMedia: bad })).statusCode).toBe(400);
  expect((await get()).canvasMedia).toEqual(media);
});

test("PUT 浏览器下载镜像：首尾空白去掉再存，空串清除，不是 http(s) 地址 400 且不落库", async () => {
  await boot();
  expect(
    (await put({ browserMirror: "  https://mirror.example/pw  " })).statusCode,
  ).toBe(200);
  expect((await get()).browserMirror).toBe("https://mirror.example/pw");
  expect((await put({ jobRemindSeconds: 300 })).statusCode).toBe(200);
  expect((await get()).browserMirror).toBe("https://mirror.example/pw");
  for (const bad of ["mirror.example", "ftp://a.b/c", 3, null])
    expect((await put({ browserMirror: bad })).statusCode, String(bad)).toBe(
      400,
    );
  expect((await get()).browserMirror).toBe("https://mirror.example/pw");
  expect((await put({ browserMirror: "" })).statusCode).toBe(200);
  expect((await get()).browserMirror).toBe("");
});
