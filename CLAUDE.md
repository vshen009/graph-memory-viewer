# CLAUDE.md

This file provides context for Claude Code when working in this directory.

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action. Do NOT answer directly, do NOT use other tools first.
The skill has specialized workflows that produce better results than ad-hoc answers.

Key routing rules:
- Product ideas, "is this worth building", brainstorming → invoke office-hours
- Bugs, errors, "why is this broken", 500 errors → invoke investigate
- Ship, deploy, push, create PR → invoke ship
- QA, test the site, find bugs → invoke qa
- Code review, check my diff → invoke review
- Update docs after shipping → invoke document-release
- Weekly retro → invoke retro
- Design system, brand → invoke design-consultation
- Visual audit, design polish → invoke design-review
- Architecture review → invoke plan-eng-review

---

## Project: graph-memory-viewer

`graph-memory-viewer` visualizes the OpenClaw `graph-memory` plugin's knowledge graph (nodes, edges, community clusters) via a local web interface using vis-network.

### Architecture

```
graph-memory.db → export-graph-memory.js → data/graph.json → viewer (5s polling)
                                                                    ↑
                            delete_node.py ← api_server.py (port 7824)
```

- **No build step** — vanilla HTML/CSS/JS with CDN libraries (vis-network, Fuse.js)
- **Two independent processes**: the export script (run manually or via cron) and the delete API server
- **The viewer never directly accesses SQLite** — all data flows through graph.json
- `gm_communities` is optional; the viewer must handle an empty/missing community gracefully

### Commands

**Export graph data:**
```bash
node scripts/export-graph-memory.js
# Options: --db <path> (default ~/.openclaw/graph-memory.db), --output <path>
# 也支持 GM_DB 环境变量
```

**Serve the viewer (required — can't open via file://):**
```bash
python3 -m http.server 8080
# Open http://localhost:8080/viewer/
```

**Start the delete API server (separate process, port 7824):**
```bash
python3 scripts/api_server.py
```

### Node Deletion Flow

1. User clicks delete in the viewer detail panel
2. `viewer/app.js` calls `DELETE http://<hostname>:7824/api/nodes/<nodeId>` (hostname 来自浏览器当前访问地址)
3. `api_server.py` invokes `scripts/delete_node.py <nodeId>`
4. `delete_node.py` deletes the node + its edges from SQLite, then re-exports graph.json
5. The viewer's 5-second poll picks up the updated graph.json

### Key Files

| File | Purpose |
|------|---------|
| `scripts/export-graph-memory.js` | Reads SQLite, writes `data/graph.json` with a field-mapping layer |
| `scripts/api_server.py` | HTTP API server for node deletion (port 7824) |
| `scripts/delete_node.py` | Actually deletes from SQLite and re-exports graph.json |
| `viewer/app.js` | vis-network initialization, 5s polling, search/filter/highlight state |
| `viewer/index.html` | DOM structure + CDN script tags (vis-network, Fuse.js) |

### Data Schema (graph.json)

Top-level: `{ meta, nodes, edges, communities }`

- **nodes**: `{ id, label, type, description, communityId, pagerank, degree, raw }`
- **edges**: `{ id, source, target, label, weight, raw }` — `source`/`target` map to DB `from_id`/`to_id`
- **communities**: `{ id, label, color, size }` — may be empty array

Node type → color: `task`=#16a34a, `skill`=#2563eb, `event`=#ea580c, `unknown`=#94a3b8

### Important Implementation Notes

- The export script's `mapNode`/`mapEdge` functions are the **only place** DB column names are referenced — the viewer and graph.json are DB-column-agnostic
- Delete API is hardcoded to `http://192.168.100.137:7824` in app.js (CORS is locked to that origin)
- `data/graph.json` and `data/*.log` are gitignored — do not commit real graph data
- Physics auto-disables after stabilization or 8s timeout to prevent continuous jitter
