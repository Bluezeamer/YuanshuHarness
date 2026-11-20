// 子代理的固定上限（subagent.md §5、§6）。深度、同时存活数等可由用户调的在设置里（store/defaults.ts）。
export const SUBAGENT_LIMITS = {
  // 派发任务描述的字符上限。
  taskMax: 20_000,
  // deliver 的 summary 字符上限（进父的上下文，超了按参数校验报错）；长内容放 report。
  summaryMax: 2000,
  // deliver 的 report 字符上限。
  reportMax: 1_000_000,
  // 子代理没交付就停下时，最多催几次，仍不交付就把最后一条回复当结果。
  nudges: 3,
  // 子代理被拒操作的原因保留条数（拓扑节点上展示）。
  deniedReasons: 3,
} as const;
