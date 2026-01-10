# 任务计划：固定左侧菜单使其不受页面滚动影响

**状态**: ✅ 已完成 (完成时间: 2026-01-10)

## 任务目标和背景

用户反馈：当前页面的左侧菜单会随页面滚动��移动，影响用户体验。需要将左侧菜单固定在视口中，使其在页面滚动时保持静止。

## 问题分析和现状

### 当前实现
- **HTML 结构**：`static/index.html:44-70` 中使用 `<aside class="sidebar">` 包含导航菜单
- **布局方式**：`.main-content` 使用 `display: flex`，`.sidebar` 与 `.content` 平级排列
- **问题原因**：`.sidebar` 缺少固定/粘性定位（`position: sticky/fixed`），导致随页面滚动

### 技术方案
采用 `position: sticky` 方案，优点：
- 相比 `position: fixed` 不会脱离文档流，布局更自然
- 响应式兼容性好，可在移动端重置为流式布局
- 与已存在的 sticky header 配合��好

## 任务分解

### 子任务 1：添加 CSS 变量 ⏳
- **文件**：`static/app/styles.css`
- **位置**：`:root` 选择器（约第 1 行）
- **修改内容**：添加 `--header-height: 72px;` 变量

### 子任务 2：修改主内容区域布局 ⏳
- **文件**：`static/app/styles.css`
- **位置**：`.main-content` 样式（约第 463 行）
- **修改内容**：添加 `align-items: flex-start;` 防止 sticky 子元素被拉伸

### 子任务 3：设置侧边栏固定定位 ⏳
- **文件**：`static/app/styles.css`
- **位置**：`.sidebar` 样式（约第 472 行）
- **修改内容**：
  - 添加 `position: sticky;`
  - 添加 `top: calc(var(--header-height) + 16px);`
  - 添加 `height: calc(100vh - var(--header-height) - 32px);`
  - 添加 `align-self: flex-start;`
  - 添加 `overflow-y: auto;`

### 子任务 4：移动端样式重置 ⏳
- **文件**：`static/app/styles.css`
- **位置**：移动端断点 `@media (max-width: 768px)` 中的 `.sidebar`（约第 2161 行）
- **修改内容**：
  - 添加 `position: static;`
  - 添加 `height: auto;`
  - 添加 `overflow: visible;`

## 预期效果

1. **桌面端**：左侧菜单固定在视口中，仅菜单内容区域可滚动
2. **移动端**：保持原有横向滚动导航行为，不受影响
3. **兼容性**：`position: sticky` 在现代浏览器中广泛支持

## 风险评估和缓解措施

### 风险点
1. **Header 高度不匹配**：如果实际 header 高度不是 72px，菜单位置会偏移
   - 缓解措施：需要验证实际 header 高度

2. **菜单内容过长**：当菜单项过多时，需要在侧边栏内部滚动
   - 缓解措施：已设置 `overflow-y: auto`

3. **移动端体验**：sticky 定位在移动端可能遮挡内容
   - 缓解措施：在移动端断点下重置为 static 定位

## 实施顺序

1. ✅ 完成需求分析和技术方案设计
2. ✅ 添加 CSS 变量
3. ✅ 修改布局样式
4. ✅ 修改侧边栏样式
5. ✅ 修改移动端样式（mobile.css 冲突修复）
6. ✅ 修复 sidebar 高度计算问题（height → max-height）
7. ✅ 给 header 添加 min-height 绑定变量
8. ✅ Code Review（两轮）

## 实际实施内容

### 修改清单

1. **`static/app/styles.css:52`**：添加 `--header-height: 72px;` 变量
2. **`static/app/styles.css:291`**：给 `.header` 添加 `min-height: var(--header-height);`
3. **`static/app/styles.css:473`**：给 `.main-content` 添加 `align-items: flex-start;`
4. **`static/app/styles.css:477-487`**：给 `.sidebar` 添加 sticky 定位相关样式
5. **`static/app/styles.css:2174-2176`**：移动端样式重置
6. **`static/app/mobile.css:136-138`**：修复 mobile.css 中的 sticky 冲突

### Code Review 发现的问题及修复

**第一轮 Review（SESSION_ID: `019ba4a4-b36d-74f1-88ab-425045f04d95`）**：
1. ❌ 头部高度未与变量同步 → ✅ 给 header 添加 `min-height: var(--header-height)`
2. ❌ Sidebar 高度计算未扣除 padding → ✅ 改用 `max-height` 替代 `height`
3. ❌ 移动端 mobile.css 中有 sticky 冲突 → ✅ 修改 mobile.css 中的 `.sidebar` 样式

**第二轮 Review（SESSION_ID: `019ba4a8-07a4-7b31-9c55-700e533cc001`）**：
- ✅ 所有问题已解决，未发现新的阻塞问题

## 验收结果

- [x] 桌面端：左侧菜单固定在视口，不随页面滚动
- [x] 移动端：保持原有横向滚动导航行为
- [x] Header 高度与变量对齐，避免遮挡
- [x] Sidebar 高度正确计算，不溢出视口
- [x] 移动端样式冲突已解决

## 经验总结

1. **多文件样式优先级**：当存在多个 CSS 文件时（如 styles.css 和 mobile.css），需要注意后加载文件的样式会覆盖前面的样式
2. **高度计算技巧**：使用 `max-height` 替代 `height` 可以让元素根据内容自适应高度，同时不超过最大值
3. **变量对齐**：使用 CSS 变量统一管理布局尺寸（如 header-height），可以避免硬编码带来的维护问题
4. **codex 协作价值**：通过两轮 review 发现并修复了初始方案中的三个关键问题，确保代码质量

## 备注

- 与 codex 协作完成技术方案分析和代码 review
- 分析阶段 SESSION_ID: `019ba48e-3472-7b10-92e2-7dd53f5aaab4`
- 第一轮 review SESSION_ID: `019ba4a4-b36d-74f1-88ab-425045f04d95`
- 第二轮 review SESSION_ID: `019ba4a8-07a4-7b31-9c55-700e533cc001`
