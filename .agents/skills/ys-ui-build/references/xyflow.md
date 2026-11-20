# xyflow（`@xyflow/react`）使用要点

何时读：改画布（`features/workspace/tabs/canvas/`）或任何用到 `@xyflow/react` 的界面时。

- **第三方库自带的 CSS 不分层**（如 `@xyflow/react/dist/base.css`），优先级压过 `@layer components` 里的规则，哪怕选择器更具体：改它的外观先找它留的 CSS 变量（xyflow 是 `--xy-*`，设在外层容器上），变量够不着的（如 `vector-effect`）才把规则写在 `@layer` 之外并注明原因。截图看到颜色或线宽没变，先怀疑这个。
- 往 xyflow 节点里放交互内容（编辑器、输入框）要加 `nodrag nopan nowheel nokey` 类；传给 `ReactFlow` 的回调必须是稳定引用（props 里的函数走 ref），否则每次父组件渲染所有节点都跟着重渲染。
- xyflow 的缩放控件（`NodeResizer`）：感应区同样要写在 `@layer` 之外，且**优先级要比库的高一级**（库的 `.react-flow__resize-control.line.right` 是三个类，同级的规则谁在后谁赢，会让 1px 的边框线跑到拉宽后的感应带外缘）；`autoScale` 默认只放大角点，要和连接点一样都按画布单位就关掉；`keepAspectRatio` 锁的是**开始缩放那一刻节点自己的宽高比**，没法传入别的比例，所以要等比例缩放的内容（图片）得先让节点比例等于内容比例。
- xyflow 的连线锚点取 handle 方框的**外沿**：想让线正好接在节点边上，handle 本体就要小（2px）并贴在边框内侧，要大的感应区与悬停圈用它的伪元素画（伪元素的点击仍算在 handle 上）；handle 默认画在节点本体之下，要盖在上面得给 `z-index`。尺寸与位置的规则要写在 `@layer` 之外（原因同上）。
- xyflow 的连线落点：松手时它按「离哪个 handle 的**中心**最近且在 `connectionRadius` 内」判断，所以铺满节点的大 handle 只有正中央有效；要「落在节点范围内就连」，在 `onConnectEnd(event, state)` 里自己做命中（`state.isValid` 为真说明已连上，别重复）。拖线时的目标高亮用 `useConnection(selector)`：它给的 `to` 已经是**画布坐标**（store 里存的是容器内像素，hook 帮你换过了，别再换一次）。
- xyflow 的框选与平移：`selectionOnDrag` + `panOnDrag={[1]}`（只留中键）+ `panActivationKeyCode="Space"`；**`panOnDrag` 里含 2（右键）时它会吞掉 `onPaneContextMenu`**，要空白处右键菜单就别含。自带的框选只选节点和「连在被选节点上的线」，不会单独选线；要框选线，读 store 里的 `userSelectionRect`（容器内像素坐标）自己对 `.react-flow__edge-path` 取样判断。触控板与物理滚轮的区分：整串滚轮事件按第一个事件定（小步长或有横向位移 = 触控板），在外层用捕获阶段的 `wheel` 监听、`stopPropagation` 拦在 xyflow 之前。
- 传给 `ReactFlow` 的右键菜单回调，菜单项每次渲染现算：把它们放进一个 ref，传出去的是转发到 ref 的稳定函数。
