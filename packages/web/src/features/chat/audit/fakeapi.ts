// api/calls 的替身函数（只被测试引用）。单独成模块是为了让 vi.mock 的工厂能 import 它而不形成环。
import { vi } from "vitest";

export const api = {
  listCalls: vi.fn(),
  listSubagentCalls: vi.fn(),
  getCall: vi.fn(),
  getCompactions: vi.fn(),
  getUsage: vi.fn(),
};
