// 必须是每个契约测试文件的第一条 import：把 HOME 与 SDK 配置目录指到临时目录，
// 即使某个用例忘了传显式路径，也碰不到开发者真实的 ~/.pi 与 ~/.agents。
import { join } from "node:path";
import { makeTmpDir } from "../support/tmp-registry.js";

export const fakeHome = makeTmpDir("yuanshu-home-");
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
process.env.PI_CODING_AGENT_DIR = join(fakeHome, ".pi", "agent");
