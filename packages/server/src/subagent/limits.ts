// subagent 的保守默认上限（ADR-0010、ADR-0060），集中放这里，需要时只改这一处。
export const SUBAGENT_LIMITS = {
  // 根会话深度 0；深度达到该值的会话不能再派发（根 → 子 → 孙）。
  maxDepth: 2,
  // 单个父会话同时运行的子会话数。
  maxConcurrentPerParent: 4,
  // 派发任务描述的字符上限。
  taskMax: 20_000,
  // 带上父历史时，取最近的消息条数与总字符数。
  historyMessages: 20,
  historyChars: 20_000,
  // 回给父的最终结果字符上限。
  resultMax: 16_000,
  // 拓扑节点上保留的被拒原因条数。
  deniedReasons: 3,
} as const;
