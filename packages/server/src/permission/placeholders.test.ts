import { describe, expect, test } from "vitest";
import { findPlaceholders, substitute } from "./placeholders.js";

const known = new Set(["tok", "gitlab_token"]);
const names = (c: string) => findPlaceholders(c, known).map((h) => h.name);
const values = new Map([["tok", "S3cr3t"]]);
const sub = async (c: string) => (await substitute(c, values)).command;

describe("占位符识别边界", () => {
  test.each([
    ["echo @tok", ["tok"]],
    ["curl -H 'X: @tok'", ["tok"]],
    ['curl --token=@tok "@gitlab_token"', ["tok", "gitlab_token"]],
    ["echo @tok.", ["tok"]],
    ["https://oauth2:@tok@host/x", ["tok"]],
    ["(echo @tok)", ["tok"]],
  ])("识别 %s", (c, want) => expect(names(c)).toEqual(want));

  test.each([
    ["mail me@tok.example.com"], // 邮箱
    ["git clone git@tok:x/y.git"], // 前面是单词字符
    ["npm i @tok/pkg"], // scope 包
    ["echo @nope"], // 未登记
    ["echo @tokens"], // 名字取最长匹配，tokens 未登记
    ["echo \\@tok"], // 转义
    ["echo $@tok"],
    ["echo @tok-extra"],
    ["echo @1tok"],
  ])("不识别 %s", (c) => expect(names(c)).toEqual([]));
});

describe("占位符改写", () => {
  test("无引号 → 双引号包住；双引号内 → 原位；单引号内 → 临时跳出", async () => {
    expect(await sub("echo @tok")).toBe('echo "${YUANSHU_VAR_tok}"');
    expect(await sub('echo "a @tok b"')).toBe('echo "a ${YUANSHU_VAR_tok} b"');
    expect(await sub("echo 'a @tok b'")).toBe(
      "echo 'a '\"${YUANSHU_VAR_tok}\"' b'",
    );
  });

  test("$(...) 内重新判断；heredoc 内不加引号；注释内不动", async () => {
    expect(await sub('echo "$(echo @tok)"')).toBe(
      'echo "$(echo "${YUANSHU_VAR_tok}")"',
    );
    expect(await sub("cat <<EOF\nv=@tok\nEOF")).toBe(
      "cat <<EOF\nv=${YUANSHU_VAR_tok}\nEOF",
    );
    const r = await substitute("echo hi # @tok", values);
    expect(r.command).toBe("echo hi # @tok");
    expect(r.env).toEqual({});
  });

  test("多处出现、中文前缀（下标按 UTF-16）", async () => {
    expect(await sub("echo 中文 @tok && echo @tok")).toBe(
      'echo 中文 "${YUANSHU_VAR_tok}" && echo "${YUANSHU_VAR_tok}"',
    );
  });

  test("命令文本里没有值；env 只含用到的变量", async () => {
    const r = await substitute(
      "echo @tok @other",
      new Map([...values, ["other", "O"]]),
    );
    expect(r.command).not.toContain("S3cr3t");
    expect(r.env).toEqual({
      YUANSHU_VAR_tok: "S3cr3t",
      YUANSHU_VAR_other: "O",
    });
    const none = await substitute("echo hi", values);
    expect(none).toEqual({ command: "echo hi", env: {} });
  });
});
