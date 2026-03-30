# Graph Memory Viewer

为 OpenClaw `graph-memory` 插件提供"接近 live"的本地可视化页面，支持查看节点、边和 Community 聚类结果。

---

## 架构

```
graph-memory.db  →  export-graph-memory.js  →  graph.json  →  viewer (vis-network)
                                                         ↑
                                                    每 5 秒轮询
```

- **导出脚本**：Node.js，内置 `node:sqlite`，无需安装额外 npm 包
- **前端**：原生 HTML/CSS/JS + vis-network（CDN）
- **数据层**：`sqlite → json`，前端永不直连数据库

---

## 文件清单

```
projects/graph-memory-viewer/
├── README.md
├── TECH-SPEC-v1.md
├── scripts/
│   ├── export-graph-memory.js   # 数据库 → JSON 导出脚本
│   ├── delete_node.py           # 节点删除脚本（从数据库真正删除）
│   └── api_server.py            # 删除 API 服务 (:7824)
├── data/
│   └── graph.json               # 导出的图数据（首次运行后生成）
└── viewer/
    ├── index.html               # 主页面
    ├── app.js                   # vis-network 逻辑 + 轮询
    └── styles.css               # 样式
```

---

## 运行方式

### 1. 生成 / 更新 graph.json

```bash
cd projects/graph-memory-viewer
node scripts/export-graph-memory.js
```

可选参数：

| 参数        | 默认值                                     | 说明       |
|-----------|-----------------------------------------|----------|
| `--db`    | `~/.openclaw/graph-memory.db`           | 数据库路径   |
| `--output`| `data/graph.json`                       | 输出文件路径  |

```bash
# 示例：指定其他数据库
node scripts/export-graph-memory.js --db /path/to/other.db

# 示例：指定输出位置
node scripts/export-graph-memory.js --output /tmp/graph.json
```

> 建议将导出脚本加入 cron 定期执行，或通过 OpenClaw cron 触发，以保持 graph.json 与数据库同步。

### 2. 启动本地静态服务

由于浏览器安全限制，页面必须通过 HTTP 服务访问（不能直接 `file://` 打开）。

**方式 A：用 Python（推荐）**

```bash
cd projects/graph-memory-viewer
python3 -m http.server 8080
# 打开 http://localhost:8080/viewer/
```

**方式 B：用 Node.js**

```bash
npx http-server projects/graph-memory-viewer -p 8080
# 打开 http://localhost:8080/viewer/
```

**方式 C：用 VS Code Live Server 插件**

在 `viewer/` 目录右键 → Open with Live Server。

---

## 功能说明

### 已实现

- ✅ 图谱可视化（节点 + 边，力导向布局）
- ✅ 节点颜色按 `type` 区分（Task=绿 / Skill=蓝 / Event=橙 / Unknown=灰）
- ✅ 节点大小按 PageRank 映射（12~40px）
- ✅ 右侧详情面板（点击节点显示：名称、描述、PageRank、度数、Community、关联边数）
- ✅ 顶部统计栏（Node 数 / Edge 数 / Community 数 / 最后更新时间）
- ✅ **每 5 秒轮询** `graph.json`，数据变化后自动重绘
- ✅ 暂停/继续轮询按钮
- ✅ 手动刷新按钮
- ✅ 图例（节点类型 + 边类型颜色说明）
- ✅ 兼容 `gm_communities = 0`（社区为空时不报错，面板显示"—"）
- ✅ 字段映射层（数据库原始列名不暴露给前端）
- ✅ 节点 hover 显示描述 tooltip
- ✅ 边 label 显示（hover 或选中时）
- ✅ **节点删除**（选中节点 → 详情面板底部删除 → 确认弹窗 → 从数据库永久删除）

### 未实现（v2 规划）

- ✅ 节点搜索框 + 按 type 筛选
- ✅ 高亮某节点一阶邻居
- ⬜ 点击边显示关系详情
- ⬜ 增量更新（目前每次刷新完全重绘）
- ⬜ 节点拖拽后保持位置
- ⬜ 导出图片

---

## 使用规范

### 与 AGENTS.md / MEMORY.md 的协同

`graph-memory` 是**主记忆库**（持久化 + 语义检索），AGENTS.md 和 MEMORY.md 中的记忆管理规范需与其保持一致：

- **检索**：涉及个人偏好、历史决策、过往事件 → `gm_search` 优先
- **写入**：新经验 / 案例 → `gm_record` 入知识图谱，`memory/lessons.md` 保留详细文字备份
- AGENTS.md 和 MEMORY.md 的记忆管理章节应同步更新，避免规则打架

### 避免多记忆插件同时启用

graph-memory 与 OpenClaw 其他记忆类插件（mem0、Flock Memory 等）**不可同时使用**，原因：

- 多套记忆系统并行 → 记忆分散，检索结果不完整，存储冗余
- 经验写入规则不一致 → 知识图谱与 lessons.md 脱节

**建议**：仅保留 `graph-memory`，卸载或禁用其他记忆类插件。

---

## 后续建议

1. **定时导出**：将 `node scripts/export-graph-memory.js` 加入 `cron 0 * * * *`（每小时更新一次 graph.json），viewer 的 5 秒轮询会自动感知变化
2. **升级到 HTTP API**：如果 graph.json 更新频繁，可将导出脚本改为轻量 HTTP 服务，避免文件 IO
3. **邻居高亮**（已实现）：点击节点后高亮其一阶邻居，其余节点暗化，提升节点关联可读性

---

## 数据隐私

`data/graph.json` 包含来自 `graph-memory.db` 的真实对话记录（任务描述、执行步骤、结果等），**不会**被提交到 GitHub。

`.gitignore` 已排除：
- `data/graph.json` — 图数据（每次运行导出脚本后重新生成）
- `data/*.log` — cron 日志

如需分享图谱，请确保数据已脱敏，或仅分享空的 `graph.json` 模板。

## 故障排查

**页面打不开**
- 必须通过 HTTP 服务访问，不能直接双击 `index.html`
- 检查 `graph.json` 是否存在：运行导出脚本

**图谱为空**
- 运行 `node scripts/export-graph-memory.js` 确认有数据导出
- 检查浏览器控制台是否有错误

**数据不更新**
- 确认 graph.json 有被定时更新（可加 cron）
- 确认没有开启"暂停"按钮
