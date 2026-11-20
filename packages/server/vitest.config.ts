import { configDefaults, defineConfig } from "vitest/config";

// test/live 下除 transfer-ssh 外都是手动冒烟，要真实模型端点（仓库根 tmp/model）和/或本机 sshd。
// 只在显式设了 YUANSHU_LIVE=1 时才跑：否则「有 tmp/model 的机器」与 CI 跑出的是两套测试，
// 默认的 `pnpm test` 还会去调真实模型。transfer-ssh 只要本机有 sshd、不碰模型，照常默认跑。
export default defineConfig({
  test: {
    // 与 web 的 vite.config.ts 一致：默认的 5 秒是按开发机定的，CI 的共享 runner 上起 sshd、PTY 的用例会超时
    testTimeout: 15_000,
    hookTimeout: 15_000,
    exclude: [
      ...configDefaults.exclude,
      ...(process.env.YUANSHU_LIVE
        ? []
        : ["test/live/!(transfer-ssh).live.test.ts"]),
    ],
  },
});
