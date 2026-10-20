import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import { Masker, maskBashOperations, StreamMasker } from "./masking.js";
import { maskingExtension } from "./masking-extension.js";

const TOK = "test-secret-aaaa";
const PW = "test-secret-bbbbbbbb";
const vars = [
  { name: "tok", value: TOK },
  { name: "pw", value: PW },
];

function streamAll(m: Masker, chunks: Buffer[]): string {
  const s = new StreamMasker(m);
  return Buffer.concat([...chunks.map((c) => s.push(c)), s.end()]).toString(
    "utf8",
  );
}

describe("Masker", () => {
  test("精确替换成 @name，未登记的内容不动", () => {
    const m = new Masker(vars);
    expect(m.mask(`a ${TOK} b ${PW} c @tok.com`)).toBe(
      "a @tok b @pw c @tok.com",
    );
  });

  test("短于 MASK_MIN 的值不参与；全都太短时视为空", () => {
    const m = new Masker([{ name: "pin", value: "1234567" }]);
    expect(m.empty).toBe(true);
    expect(m.mask("pin 1234567")).toBe("pin 1234567");
  });

  test("同一位置多个值都匹配时取最长的", () => {
    const m = new Masker([
      { name: "short", value: "test-secret" },
      { name: "long", value: "test-secret-long" },
    ]);
    expect(m.mask("x test-secret-long y test-secret z")).toBe(
      "x @long y @short z",
    );
  });

  test("值里的正则元字符按字面匹配", () => {
    const m = new Masker([{ name: "k", value: "a.b*c+d?(e)[f]$^|\\" }]);
    expect(m.mask("1 a.b*c+d?(e)[f]$^|\\ 2 aXb")).toBe("1 @k 2 aXb");
  });

  test("maskDeep 递归处理字符串叶子，其余类型原样", () => {
    const m = new Masker(vars);
    expect(
      m.maskDeep({ a: [TOK, 1, null, { b: `x${PW}` }], c: true, d: undefined }),
    ).toEqual({ a: ["@tok", 1, null, { b: "x@pw" }], c: true, d: undefined });
  });
});

describe("StreamMasker 分块边界", () => {
  const text = `head ${TOK} mid ${PW} tail`;
  const want = "head @tok mid @pw tail";

  test("任意单个切分点结果都等于整段遮罩", () => {
    const m = new Masker(vars);
    const buf = Buffer.from(text);
    for (let i = 0; i <= buf.length; i++) {
      expect(streamAll(m, [buf.subarray(0, i), buf.subarray(i)])).toBe(want);
    }
  });

  test("逐字节喂入", () => {
    const m = new Masker(vars);
    const buf = Buffer.from(text);
    const chunks = Array.from({ length: buf.length }, (_, i) =>
      buf.subarray(i, i + 1),
    );
    expect(streamAll(m, chunks)).toBe(want);
  });

  test("以值的前缀结尾但并不是值：结束时原样冲出", () => {
    const m = new Masker(vars);
    expect(streamAll(m, [Buffer.from("x test-secr")])).toBe("x test-secr");
    expect(
      streamAll(m, [Buffer.from("x test-sec"), Buffer.from("ret-zzzz y")]),
    ).toBe("x test-secret-zzzz y");
  });

  test("已完整的值同时是更长值的前缀：等到能区分再放行", () => {
    const m = new Masker([
      { name: "short", value: "test-secret" },
      { name: "long", value: "test-secret-long" },
    ]);
    const buf = Buffer.from("a test-secret-long b test-secret c");
    for (let i = 0; i <= buf.length; i++) {
      expect(streamAll(m, [buf.subarray(0, i), buf.subarray(i)])).toBe(
        "a @long b @short c",
      );
    }
  });

  test("多字节字符被切开：值含中文，按每个字节切分", () => {
    const zh = "密码密码密码密码";
    const m = new Masker([{ name: "zh", value: zh }]);
    const buf = Buffer.from(`前缀${zh}后缀`);
    for (let i = 0; i <= buf.length; i++) {
      expect(streamAll(m, [buf.subarray(0, i), buf.subarray(i)])).toBe(
        "前缀@zh后缀",
      );
    }
  });

  test("滞留的只是尾部：无关长文本不会被整体扣住", () => {
    const m = new Masker(vars);
    const s = new StreamMasker(m);
    const out = s.push(Buffer.from(`${"x".repeat(1000)}test-sec`));
    expect(out.toString()).toBe("x".repeat(1000));
    expect(s.end().toString()).toBe("test-sec");
  });

  test("没有可遮罩的变量时原样透传", () => {
    const s = new StreamMasker(new Masker([]));
    const b = Buffer.from("anything");
    expect(s.push(b)).toBe(b);
    expect(s.end().length).toBe(0);
  });
});

describe("maskBashOperations", () => {
  const run = async (
    m: Masker,
    emit: (onData: (d: Buffer) => void) => void,
    fail = false,
  ) => {
    const got: string[] = [];
    const ops: BashOperations = {
      exec: async (_c, _d, o) => {
        emit(o.onData);
        if (fail) throw new Error("boom");
        return { exitCode: 0 };
      },
    };
    const res = await maskBashOperations(ops, m)
      .exec("x", "/", { onData: (d) => got.push(d.toString()) })
      .catch((e: Error) => e);
    return { out: got.join(""), res };
  };

  test("值被切在两次 onData 之间也会被遮罩，且结束时冲出尾部", async () => {
    const { out } = await run(new Masker(vars), (on) => {
      on(Buffer.from("a test-sec"));
      on(Buffer.from("ret-aaaa b test-se"));
    });
    expect(out).toBe("a @tok b test-se");
  });

  test("命令失败时已滞留的尾部仍会冲出", async () => {
    const { out, res } = await run(
      new Masker(vars),
      (on) => on(Buffer.from("err test-secret-bb")),
      true,
    );
    expect(res).toBeInstanceOf(Error);
    expect(out).toBe("err test-secret-bb");
  });

  test("没有可遮罩的变量时返回原 operations", () => {
    const ops: BashOperations = { exec: async () => ({ exitCode: 0 }) };
    expect(maskBashOperations(ops, new Masker([]))).toBe(ops);
  });
});

describe("maskingExtension", () => {
  function hook(list: typeof vars) {
    let h: ((e: never) => unknown) | undefined;
    maskingExtension(() => list)({
      on: (name: string, fn: (e: never) => unknown) => {
        if (name === "tool_result") h = fn;
      },
    } as never);
    if (!h) throw new Error("tool_result 钩子未注册");
    return h;
  }

  test("遮罩文本块、structuredContent 与 details；图片块不动", () => {
    const img = { type: "image", data: TOK, mimeType: "image/png" };
    const r = hook(vars)({
      content: [{ type: "text", text: `read ${TOK}` }, img],
      structuredContent: { output: `${PW}\n`, exit_code: 0 },
      details: { note: TOK },
    } as never) as Record<string, unknown>;
    expect(r.content).toEqual([{ type: "text", text: "read @tok" }, img]);
    expect(r.structuredContent).toEqual({ output: "@pw\n", exit_code: 0 });
    expect(r.details).toEqual({ note: "@tok" });
  });

  test("未提供 structuredContent / details 时不凭空产生", () => {
    const r = hook(vars)({
      content: [{ type: "text", text: "plain" }],
    } as never) as Record<string, unknown>;
    expect(Object.keys(r)).toEqual(["content"]);
  });

  test("没有可遮罩的变量时不改结果", () => {
    expect(
      hook([])({ content: [{ type: "text", text: TOK }] } as never),
    ).toBeUndefined();
  });

  test("每次取最新清单：登记之后立即生效", () => {
    let list: typeof vars = [];
    let h: ((e: never) => unknown) | undefined;
    maskingExtension(() => list)({
      on: (_n: string, fn: (e: never) => unknown) => {
        h = fn;
      },
    } as never);
    const ev = { content: [{ type: "text", text: TOK }] } as never;
    expect(h?.(ev)).toBeUndefined();
    list = vars;
    expect(h?.(ev)).toEqual({ content: [{ type: "text", text: "@tok" }] });
  });
});
