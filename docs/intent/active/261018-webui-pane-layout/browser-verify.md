# Browser Verification: Pane Layer Preservation (R3/R4)
Date: 2026-10-18
Verifier: 待人工

> 目的：验证 pane 层在真实浏览器里经拖动、切换 window、分割、调整尺寸后保持同一 DOM 节点，iframe 不重载。
> ADR-0027 定保活机制以此为前提，做不到则回到 ADR 重议。

## Setup
1. 先起真实 Server（`vite.config` 代理 `/api` 到 `127.0.0.1:7420`），再 `cd packages/web && pnpm dev`，按 Vite 输出的地址打开。
2. 输入令牌进入对话页。
3. 打开浏览器开发者工具 Console。

## Instrumentation
在 Console 粘贴以下代码，为 pane 层的每个 pane 打上稳定标记并监听 iframe 的 `load` 事件：

```js
const marks = new WeakMap();
const iframeLoads = new Map(); // paneId -> count
let nextId = 1;

function instrument() {
  document.querySelectorAll('[data-pane-id]').forEach(el => {
    const id = el.getAttribute('data-pane-id');
    if (!marks.has(el)) {
      marks.set(el, `node-${nextId++}`);
      console.log(`[instrument] pane ${id} mounted as ${marks.get(el)}`);
    }
    const iframe = el.querySelector('iframe');
    if (iframe && !iframe._tracked) {
      iframe._tracked = true;
      iframeLoads.set(id, (iframeLoads.get(id) || 0));
      iframe.addEventListener('load', () => {
        iframeLoads.set(id, (iframeLoads.get(id) || 0) + 1);
        console.warn(`[iframe] pane ${id} load count: ${iframeLoads.get(id)}`);
      });
    }
  });
}

function check(paneId, label) {
  const el = document.querySelector(`[data-pane-id="${paneId}"]`);
  if (!el) return console.error(`[check] pane ${paneId} not found`);
  const mark = marks.get(el);
  const input = el.querySelector('input, textarea');
  const value = input ? input.value : '(no input)';
  const scroll = el.scrollTop || 0;
  const iframeLoadCount = iframeLoads.get(paneId) || 0;
  console.log(`[${label}] pane ${paneId}: mark=${mark}, value="${value}", scroll=${scroll}, iframe loads=${iframeLoadCount}`);
  return { mark, value, scroll, iframeLoadCount };
}

// 自动重新扫描
setInterval(instrument, 500);
instrument();
```

## Test Sequence
对每一步记录：操作前 `check()` 的结果，操作，操作后 `check()` 的结果。标记（mark）不变说明 DOM 节点保持，iframe load 计数不增说明没有重载。

### Case 1: 同一 window 内分割与调整尺寸
1. 选中会话「甲」，在第一个 chat pane 的输入框里打「半截输入」，不发送。记下 pane id（假设为 `p1`），在 Console 执行 `check('p1', 'before-split')`。
2. 点击 pane 标题栏的「向右分割」，得到第二个 pane（假设为 `p2`）。执行 `check('p1', 'after-split')`。
3. 拖动 `p1` 与 `p2` 之间的分割线，执行 `check('p1', 'after-resize')`。

**预期**：`p1` 的 mark 在 before-split、after-split、after-resize 三次 check 里都相同；输入框内容始终为「半截输入」；iframe load 计数始终为 0（chat pane 没有 iframe）。

### Case 2: 跨 window 移动
1. 点击「新建 window」，切到新 window（空态）。
2. 将 `p1` 移到新 window：用标题栏的「移动到其他 window」入口，或把标题栏拖到另一个 window 标签上（pointer 拖动）。执行 `check('p1', 'after-move')`。
3. 切回第一个 window，再切回第二个 window，执行 `check('p1', 'after-switch')`。

**预期**（实现后）：`p1` 的 mark 在 after-move 和 after-switch 与 before-split 时相同；输入框内容不变。

### Case 3: iframe pane 不重载（待 web_preview 真实实现后测）
第一期 `web_preview` 渲染「尚未可用」，没有 iframe，此用例暂时跳过。记录：待 web_preview 实现后补测。

## Results
| 步骤 | pane | mark | 输入框内容 | iframe loads | 通过？ |
|---|---|---|---|---|---|
| before-split | p1 | | | 0 | |
| after-split | p1 | | | 0 | |
| after-resize | p1 | | | 0 | |
| after-move | p1 | | | 0 | |
| after-switch | p1 | | | 0 | |

（待人工填写）

## Conclusion
（待人工：mark 全程一致则通过，否则回到 ADR-0027 重议保活机制。）

补充：Case 2 也要用 pointer 拖动各测一次，并确认拖动经过 iframe 上方时遮罩仍能收到事件（R5）。
