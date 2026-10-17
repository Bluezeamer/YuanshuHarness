import "./isolate.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import { makeEnv, tmpDir } from "./harness.js";
import { fakeHome } from "./isolate.js";

// R8：SDK 实际扫描的 skill 目录。
function skill(dir: string, name: string) {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(
    join(dir, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: contract test skill ${name}\n---\n\nbody\n`,
  );
}

async function discovered(
  env: ReturnType<typeof makeEnv>,
  extra: ConstructorParameters<typeof DefaultResourceLoader>[0] extends infer O
    ? Partial<O>
    : never = {},
) {
  const loader = new DefaultResourceLoader({
    cwd: env.cwd,
    agentDir: env.agentDir,
    ...extra,
  });
  await loader.reload();
  return loader
    .getSkills()
    .skills.map((s) => s.name)
    .sort();
}

test("R8 扫描目录内被发现：<agentDir>/skills、<cwd>/.pi/skills、<cwd>/.agents/skills、~/.agents/skills", async () => {
  const env = makeEnv();
  skill(join(env.agentDir, "skills"), "in-agent-dir");
  skill(join(env.cwd, ".pi", "skills"), "in-cwd-pi");
  skill(join(env.cwd, ".agents", "skills"), "in-cwd-agents");
  skill(join(fakeHome, ".agents", "skills"), "in-home-agents");
  const names = await discovered(env);
  expect(names).toEqual(
    expect.arrayContaining([
      "in-agent-dir",
      "in-cwd-agents",
      "in-cwd-pi",
      "in-home-agents",
    ]),
  );
});

test("R8 扫描目录外不被发现", async () => {
  const env = makeEnv();
  skill(join(env.cwd, "random", "skills"), "outside-1");
  skill(tmpDir(), "outside-2");
  skill(join(env.agentDir, "not-skills"), "outside-3");
  const names = await discovered(env);
  expect(names).not.toContain("outside-1");
  expect(names).not.toContain("outside-2");
  expect(names).not.toContain("outside-3");
});

test("R8 Server 可显式追加目录（additionalSkillPaths），并可整体关闭自动扫描（noSkills）", async () => {
  const env = makeEnv();
  const extraDir = tmpDir();
  skill(extraDir, "from-extra");
  skill(join(env.cwd, ".pi", "skills"), "in-cwd-pi");
  expect(await discovered(env, { additionalSkillPaths: [extraDir] })).toContain(
    "from-extra",
  );
  const closed = await discovered(env, {
    noSkills: true,
    additionalSkillPaths: [extraDir],
  });
  expect(closed).not.toContain("in-cwd-pi");
});
