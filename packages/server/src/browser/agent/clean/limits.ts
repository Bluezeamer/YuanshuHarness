// 快照管线的全部阈值（设计稿 §7 / §8）。后面的模块与接线都从这里取，别处不再写数字。
export const CLEAN_LIMITS = {
  /** 机械层输出不超过它（字符）就直接给，不调辅助模型 */
  directMaxChars: 800,
  /** 辅助模型单次调用读得下的上限（字符）；机械层输出超过它就走「只读 agent + 结构视图」 */
  singleCallMaxChars: 60_000,
  /** 没配辅助模型时，机械层输出的内联上限（字符）；超过就给结构视图加文件 */
  inlineMaxChars: 12_000,
  /** 动作之后 diff 的内联上限（字符）；超过就只截断内联、全文存附件，不换路径 */
  diffMaxChars: 6_000,
  /** 结构视图里每条保留的行最多留多少字符 */
  structureLineChars: 150,
  /** 辅助模型自由写的文字的上限 */
  gistMaxChars: 200,
  captionMaxChars: 80,
  /** overview 最多几个部分、每部分最多几个代表元素、逐字引用最多几行 */
  partsMax: 20,
  refsPerPartMax: 6,
  quoteMaxLines: 40,
  /** 引用的单行最多留多少字符（超出写 …(+N chars)） */
  quoteLineChars: 2_000,
} as const;
