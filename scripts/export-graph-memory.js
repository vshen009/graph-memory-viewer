#!/usr/bin/env node
/**
 * export-graph-memory.js
 * 从 graph-memory.db 导出 graph.json，供前端 viewer 使用。
 * 用法: node export-graph-memory.js [--db <path>] [--output <path>]
 */

'use strict';

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

// ── 字段映射层 ──────────────────────────────────────────────────────────────
// DB 原始字段 → 前端标准化字段
// 所有前端代码只依赖这里的标准化字段名，不直接碰 DB 列名。

const TYPE_COLOR_MAP = {
  TASK:    '#16a34a',   // 绿色
  SKILL:   '#2563eb',   // 蓝色
  EVENT:   '#ea580c',   // 橙色
};

const TYPE_DEFAULT_COLOR = '#94a3b8'; // 灰色（兜底）

function typeToColor(type) {
  return TYPE_COLOR_MAP[type?.toUpperCase()] ?? TYPE_DEFAULT_COLOR;
}

/**
 * 将 DB 原始 node 记录映射为前端标准化 node 对象
 */
function mapNode(row) {
  return {
    id:          row.id,
    label:       row.name ?? '(无名称)',
    type:        (row.type ?? 'unknown').toLowerCase(),
    description: row.description ?? '',
    content:     row.content ?? '',        // 额外字段，放 raw 里保留
    communityId: row.community_id ?? null,
    pagerank:    row.pagerank ?? 0,
    degree:      0,                         // 度数由导出时计算
    status:      row.status ?? 'active',
    raw: {
      name:            row.name,
      description:     row.description,
      content:         row.content,
      status:          row.status,
      validatedCount:  row.validated_count,
      sourceSessions:  JSON.parse(row.source_sessions ?? '[]'),
      createdAt:       row.created_at,
      updatedAt:       row.updated_at,
    },
  };
}

/**
 * 将 DB 原始 edge 记录映射为前端标准化 edge 对象
 */
function mapEdge(row) {
  return {
    id:      row.id,
    source:  row.from_id,
    target:  row.to_id,
    label:   row.type ?? '',
    weight:  1,
    raw: {
      instruction: row.instruction,
      condition:   row.condition,
      sessionId:  row.session_id,
      createdAt:  row.created_at,
    },
  };
}

/**
 * 将 DB 原始 community 记录映射为前端标准化 community 对象
 */
function mapCommunity(row, colorIndex) {
  const COLORS = [
    '#4F46E5', '#0891B2', '#059669', '#D97706',
    '#DC2626', '#7C3AED', '#DB2777', '#65A30D',
  ];
  return {
    id:    row.id,
    label: row.summary ?? '(无描述)',
    color: COLORS[colorIndex % COLORS.length],
    size:  row.node_count ?? 0,
  };
}

// ── 主导出逻辑 ───────────────────────────────────────────────────────────────

function exportGraph({ dbPath, outputPath }) {
  const db = new DatabaseSync(dbPath, { readonly: true });

  // 1. 读取 nodes
  const nodeRows = db.prepare(`
    SELECT id, type, name, description, content, status,
           community_id, pagerank, source_sessions, created_at, updated_at
    FROM gm_nodes
    WHERE status = 'active'
  `).all();

  const validNodeIds = new Set(nodeRows.map(r => r.id));

  // 2. 读取 edges（只保留两端都存在的边）
  const edgeRows = db.prepare(`
    SELECT id, from_id, to_id, type, instruction, condition, session_id, created_at
    FROM gm_edges
  `).all();

  const filteredEdges = edgeRows.filter(r => validNodeIds.has(r.from_id) && validNodeIds.has(r.to_id));

  // 3. 读取 messages 总数
  let messageCount = 0;
  try {
    messageCount = db.prepare('SELECT COUNT(*) as cnt FROM gm_messages').get().cnt;
  } catch (err) {
    console.warn('[export] gm_messages 表查询失败:', err.message);
  }

  // 4. 读取 communities（兼容空表）
  let communityRows = [];
  try {
    communityRows = db.prepare('SELECT id, summary, node_count FROM gm_communities').all();
  } catch (err) {
    console.warn('[export] gm_communities 表查询失败:', err.message);
  }

  // 4. 计算每个节点的度数
  const degreeMap = {};
  for (const r of filteredEdges) {
    degreeMap[r.from_id] = (degreeMap[r.from_id] ?? 0) + 1;
    degreeMap[r.to_id]   = (degreeMap[r.to_id] ?? 0) + 1;
  }

  // 5. 映射到前端格式
  const nodes = nodeRows.map(row => ({
    ...mapNode(row),
    degree: degreeMap[row.id] ?? 0,
  }));

  const edges = filteredEdges.map(mapEdge);

  const communities = communityRows.map((row, i) => mapCommunity(row, i));

  db.close();

  // 6. 写入 graph.json
  const output = {
    meta: {
      generatedAt:    new Date().toISOString(),
      sourceDb:       dbPath,
      nodeCount:      nodes.length,
      edgeCount:      edges.length,
      communityCount: communities.length,
      messageCount:   messageCount,
      version:        1,
    },
    nodes,
    edges,
    communities,
  };

  const json = JSON.stringify(output, null, 2);
  fs.writeFileSync(outputPath, json, 'utf8');

  console.log(`[export] 完成 → ${outputPath}`);
  console.log(`  nodes: ${nodes.length}, edges: ${edges.length}, communities: ${communities.length}`);
}

// ── CLI 入口 ─────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  let dbPath    = process.env.GM_DB || '/home/trinity/.openclaw/graph-memory.db';
  let outputPath = path.join(__dirname, '..', 'data', 'graph.json');

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--db' && args[i + 1]) dbPath = args[++i];
    else if (args[i] === '--output' && args[i + 1]) outputPath = args[++i];
    else if (args[i] === '--help') {
      console.log('用法: node export-graph-memory.js [--db <path>] [--output <path>]');
      process.exit(0);
    }
  }

  if (!fs.existsSync(dbPath)) {
    console.error(`[export] 数据库文件不存在: ${dbPath}`);
    process.exit(1);
  }

  // 确保输出目录存在
  const outDir = path.dirname(outputPath);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  exportGraph({ dbPath, outputPath });
}

main();
