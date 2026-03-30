/**
 * app.js – graph-memory-viewer
 * vis-network based, 5-second polling, detail panel.
 */

'use strict';

// ── 配置 ────────────────────────────────────────────────────────────────────

const CONFIG = {
  dataUrl:      '../data/graph.json',
  pollInterval: 5_000,
  colorMode:    'type',  // 'community' | 'type'（节点着色优先用 type，严格按 Task/Skill/Event/Unknown 着色）
  typeColors: {
    task:    '#16a34a',
    skill:   '#2563eb',
    event:   '#ea580c',
    unknown: '#94a3b8',
  },
  communityColorMap: {},   // 运行时填充
  edgeTypeColors: {
    USED_SKILL:    '#38bdf8',
    SOLVED_BY:     '#4ade80',
    REQUIRES:      '#fb923c',
    PATCHES:       '#a78bfa',
    CONFLICTS_WITH:'#f87171',
  },
};

let network        = null;
let graphData      = null;
let selectedNodeId = null;
let isPaused       = false;
let pollTimer      = null;
let physicsTimer   = null;

// v2 状态机
let neighborMap  = new Map();   // nodeId → Set<neighborId>
let fuse          = null;        // Fuse.js instance
let filterState   = { search: '', type: 'all' };
let highlightState = { nodeId: null, neighborIds: [] };
let searchDebounce = null;

// 暴露给外部（测试用）
window._graph = { getNetwork: () => network, getGraphData: () => graphData };

// ── DOM refs ─────────────────────────────────────────────────────────────────

const $stats = {
  nodes:      document.getElementById('stat-nodes'),
  edges:      document.getElementById('stat-edges'),
  communities:document.getElementById('stat-communities'),
  messages:   document.getElementById('stat-messages'),
  updated:   document.getElementById('updated-time'),
};
const $detail     = document.getElementById('detail-panel');
const $pauseBtn   = document.getElementById('pause-btn');
const $forceBtn   = document.getElementById('force-btn');
const $statusBar  = document.getElementById('status-bar');
const $searchBox  = document.getElementById('search-box');
const $searchClear= document.getElementById('search-clear');
const $typeFilter = document.getElementById('type-filter');

// ── 工具 ─────────────────────────────────────────────────────────────────────

function nodeColor(type) {
  return CONFIG.typeColors[type?.toLowerCase()] ?? CONFIG.typeColors.unknown;
}

function edgeColor(label) {
  return CONFIG.edgeTypeColors[label?.toUpperCase()] ?? '#64748b';
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
}

// ── v2: Fuse.js ───────────────────────────────────────────────────────────────

function initFuse(nodes) {
  if (typeof Fuse !== 'undefined') {
    fuse = new Fuse(nodes, {
      keys: ['label'],
      threshold: 0.4,
      includeMatches: false,
      minMatchCharLength: 1,
    });
  } else {
    // CDN 不可达，降级到 substring 匹配
    fuse = {
      search(q) {
        const l = q.toLowerCase();
        return nodes
          .filter(n => n.label.toLowerCase().includes(l))
          .map(item => ({ item }));
      },
    };
  }
}

// ── v2: 邻居查找 ─────────────────────────────────────────────────────────────

function buildNeighborMap(edges) {
  neighborMap = new Map();
  edges.forEach(e => {
    if (!neighborMap.has(e.source)) neighborMap.set(e.source, new Set());
    if (!neighborMap.has(e.target)) neighborMap.set(e.target, new Set());
    neighborMap.get(e.source).add(e.target);
    neighborMap.get(e.target).add(e.source);
  });
}

function getNeighborIds(nodeId) {
  return neighborMap.get(nodeId) ?? new Set();
}

// ── v2: 状态渲染 ─────────────────────────────────────────────────────────────

function applyVisuals(fs = filterState, hs = highlightState) {
  if (!network || !graphData) return;

  const visNodes = network.body.data.nodes;

  // 收集匹配节点
  let matchedIds = new Set();
  if (fs.search.trim()) {
    const results = fuse.search(fs.search.trim());
    matchedIds = new Set(results.map(r => r.item.id));
  }

  const typeVal = fs.type === 'all' ? null : fs.type;
  const hsNodeId = hs.nodeId;
  const hsNeighborIds = new Set(hs.neighborIds);

  const updates = [];
  visNodes.forEach(n => {
    const nodeData = n._node ?? {};
    const isHighlighted = hsNodeId !== null && (n.id === hsNodeId || hsNeighborIds.has(n.id));
    const isFiltered = fs.search.trim() && !matchedIds.has(n.id);
    const isTypeFiltered = typeVal !== null && (nodeData.type ?? '').toLowerCase() !== typeVal;

    // 高亮状态优先：被点节点 + 邻居永远显示
    // 否则按 filterState 决定
    const dimmed = !isHighlighted && (isFiltered || isTypeFiltered);

    updates.push({
      id: n.id,
      opacity: dimmed ? 0.08 : 1,
    });
  });

  visNodes.update(updates);
  updateStatusBar(fs, hs, matchedIds.size);
}

function updateStatusBar(fs, hs, matchedCount) {
  if (hs.nodeId !== null) {
    const node = graphData?.nodes?.find(n => n.id === hs.nodeId);
    $statusBar.textContent = `🔵 高亮: ${node?.label ?? hs.nodeId} · ${hs.neighborIds.length} 个邻居`;
  } else if (fs.search.trim()) {
    $statusBar.textContent = `🔍 筛选: '${fs.search}' · ${matchedCount} 个匹配节点`;
  } else if (fs.type !== 'all') {
    const labels = { task: '任务', skill: '技能', event: '事件' };
    $statusBar.textContent = `🔍 筛选: ${labels[fs.type] ?? fs.type}`;
  } else {
    $statusBar.textContent = '● 实时监控中';
  }
}

function flashStatus(msg, duration = 2500) {
  $statusBar.textContent = msg;
  $statusBar.classList.remove('fade');
  clearTimeout($statusBar._t);
  $statusBar._t = setTimeout(() => {
    if (!isPaused) {
      $statusBar.textContent = '● 实时监控中';
      $statusBar.classList.add('fade');
    }
  }, duration);
}

// ── vis-network 数据转换 ─────────────────────────────────────────────────────

function buildVisData(data) {
  // 建立 communityId → color 的映射
  if (data.communities) {
    CONFIG.communityColorMap = {};
    data.communities.forEach(c => {
      CONFIG.communityColorMap[c.id] = c.color || '#94a3b8';
    });
  }

  const nodeColor = CONFIG.colorMode === 'community'
    ? n => CONFIG.communityColorMap[n.communityId] ?? '#94a3b8'
    : n => CONFIG.typeColors[n.type?.toLowerCase()] ?? CONFIG.typeColors.unknown;

  const nodes = data.nodes.map(n => ({
    id:     n.id,
    label:  n.label,
    title:  n.description || n.label,
    color: {
      background: nodeColor(n),
      border:     nodeColor(n),
      highlight: { background: '#fff', border: nodeColor(n) },
      hover:     { background: nodeColor(n), border: '#fff' },
    },
    size:  Math.max(12, Math.min(40, 12 + (n.pagerank ?? 0) * 120)),
    font:  { color: '#e2e8f0', size: 12, face: 'system-ui' },
    shape: 'dot',
    shadow: true,
    _node: n,
  }));

  const edges = data.edges.map(e => ({
    id:    e.id,
    from:  e.source,   // DB 导出字段是 source/target
    to:    e.target,
    label: e.label,
    color: { color: edgeColor(e.label), highlight: edgeColor(e.label) },
    arrows: 'to',
    smooth: { type: 'continuous' },
    width:  1.2,
    font:   { align: 'middle', size: 10, color: '#64748b', face: 'system-ui', background: 'rgba(15,23,42,0.7)' },
    _edge: e,
  }));

  return { nodes, edges };
}

// ── 关闭 physics（双保险：事件 + 超时兜底）──────────────────────────────

function disablePhysics() {
  if (!network) return;
  try {
    network.setOptions({ physics: { enabled: false } });
    console.log('[Graph] physics disabled');
  } catch (err) {
    console.warn('[Graph] setOptions physics=false failed:', err);
  }
  clearTimeout(physicsTimer);
  physicsTimer = null;
}

// ── vis-network 初始化 ────────────────────────────────────────────────────────

function initNetwork(visData) {
  const container = document.getElementById('network');
  console.log('[Graph] container:', container.offsetWidth, 'x', container.offsetHeight);

  const options = {
    nodes: { borderWidth: 2 },
    edges: { selectionWidth: 2 },
    physics: {
      enabled: true,
      solver: 'forceAtlas2Based',
      forceAtlas2Based: {
        gravitationalConstant: -50,
        centralGravity: 0.01,
        springLength: 140,
        springConstant: 0.08,
        damping: 0.4,
      },
      stabilization: { iterations: 200 },
    },
    interaction: {
      hover: true,
      tooltipDelay: 200,
      zoomView: true,
      dragView: true,
    },
  };

  try {
    // eslint-disable-next-line no-undef
    network = new vis.Network(container, visData, options);
    console.log('[Graph] network created, nodes:', visData.nodes.length, 'edges:', visData.edges.length);
  } catch (err) {
    console.error('[Graph] new vis.Network failed:', err);
    flashStatus(`渲染失败: ${err.message}`);
    return;
  }

  // 事件监听（双保险：事件触发 + 8秒超时兜底）
  try {
    network.once('stabilizationIterationsDone', () => {
      console.log('[Graph] stabilization done event');
      disablePhysics();
    });
    console.log('[Graph] stabilization listener attached');
  } catch (err) {
    console.warn('[Graph] once() failed:', err);
  }

  physicsTimer = setTimeout(() => {
    console.log('[Graph] physics timeout fallback firing');
    disablePhysics();
  }, 8000);

  network.on('click', params => {
    if (params.nodes.length === 1) {
      const clickedId = params.nodes[0];
      if (highlightState.nodeId === clickedId) {
        // 再次点击同一节点 → 清除高亮
        highlightState = { nodeId: null, neighborIds: [] };
        applyVisuals();
        hideDetail();
      } else {
        // 高亮该节点及其一阶邻居
        highlightState = {
          nodeId: clickedId,
          neighborIds: Array.from(getNeighborIds(clickedId)),
        };
        applyVisuals();
        showNodeDetail(clickedId);
      }
    } else {
      // 点击空白区域 → 清除高亮
      highlightState = { nodeId: null, neighborIds: [] };
      applyVisuals();
      hideDetail();
    }
  });
}

// ── 数据加载 & 轮询 ───────────────────────────────────────────────────────────

async function fetchGraph() {
  if (isPaused) return;

  let fresh;
  try {
    const res = await fetch(`${CONFIG.dataUrl}?_=${Date.now()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    fresh = await res.json();
    console.log('[Graph] fetched:', fresh.meta);
  } catch (err) {
    console.error('[Graph] fetch failed:', err);
    flashStatus(`获取数据失败: ${err.message}`);
    return;
  }

  const changed = !graphData
    || graphData.meta?.generatedAt !== fresh.meta?.generatedAt
    || graphData.meta?.nodeCount  !== fresh.meta?.nodeCount
    || graphData.meta?.edgeCount  !== fresh.meta?.edgeCount;

  graphData = fresh;
  updateStats(fresh.meta);

  // v2: 重建 neighborMap（O edges）和 fuse 实例
  buildNeighborMap(fresh.edges ?? []);
  initFuse(fresh.nodes ?? []);

  // 数据刷新时清除高亮状态（简化实现）
  highlightState = { nodeId: null, neighborIds: [] };

  const ts = document.getElementById('updated-time');
  if (ts) ts.textContent = fmtTime(fresh.meta?.generatedAt);

  if (changed) {
    const vd = buildVisData(fresh);
    console.log('[Graph] visData built — nodes:', vd.nodes.length, 'edges:', vd.edges.length);

    if (!network) {
      initNetwork(vd);
    } else {
      try {
        network.setData(vd);
        // v2: 重绘后重新应用过滤/高亮状态
        applyVisuals();
        // 重启物理引擎（重绘后重新稳定）
        network.setOptions({ physics: { enabled: true, stabilization: { iterations: 60 } } });
        clearTimeout(physicsTimer);
        physicsTimer = setTimeout(disablePhysics, 6000);
      } catch (err) {
        console.error('[Graph] setData failed:', err);
        flashStatus(`渲染失败: ${err.message}`);
        return;
      }
    }

    if (selectedNodeId) {
      const stillThere = fresh.nodes?.find(n => n.id === selectedNodeId);
      if (stillThere) updateNodeDetail(stillThere);
      else hideDetail();
    }

    flashStatus(`已更新 · ${fresh.meta?.nodeCount ?? 0} 节点 / ${fresh.meta?.edgeCount ?? 0} 边`);
  }
}

function startPolling() {
  pollTimer = setInterval(fetchGraph, CONFIG.pollInterval);
}

// 强制重新加载（不受 isPaused 影响，用于删除后刷新）
async function reloadGraph() {
  const wasPaused = isPaused;
  isPaused = false;
  await fetchGraph();
  isPaused = wasPaused;
}

// ── 顶部统计栏 ────────────────────────────────────────────────────────────────

function updateStats(meta) {
  // fallback：从 graphData 直接计数（防止 meta 字段缺失时全为 0）
  const nodes = graphData?.nodes ?? [];
  const edges = graphData?.edges ?? [];
  const communities = graphData?.communities ?? [];

  if ($stats.nodes)      $stats.nodes.textContent      = meta?.nodeCount      ?? nodes.length;
  if ($stats.edges)      $stats.edges.textContent      = meta?.edgeCount      ?? edges.length;
  if ($stats.communities) $stats.communities.textContent = meta?.communityCount ?? communities.length;
  if ($stats.messages)   $stats.messages.textContent   = meta?.messageCount   ?? 0;
}

// ── 右侧详情面板 ──────────────────────────────────────────────────────────────

function showNodeDetail(nodeId) {
  selectedNodeId = nodeId;
  const node = graphData?.nodes?.find(n => n.id === nodeId);
  if (!node) return;
  updateNodeDetail(node);
  $detail.classList.remove('hidden');
}

function updateNodeDetail(node) {
  const typeColor = CONFIG.typeColors[node.type?.toLowerCase()] ?? CONFIG.typeColors.unknown;
  const typeLabel = (node.type ?? 'unknown').toUpperCase();

  const connectedEdges = graphData?.edges?.filter(
    e => e.source === node.id || e.target === node.id
  ) ?? [];

  const community = node.communityId && node.communityId > 0
    ? (graphData?.communities?.find(c => c.id === node.communityId)?.label ?? String(node.communityId))
    : '—';

  document.getElementById('detail-type').textContent   = typeLabel;
  document.getElementById('detail-type').style.cssText = `background:${typeColor}22;color:${typeColor};border:1px solid ${typeColor}44`;
  document.getElementById('detail-name').textContent   = node.label ?? '—';
  document.getElementById('detail-desc').textContent   = node.description || '(无描述)';
  document.getElementById('detail-community').textContent = community;
  document.getElementById('detail-pagerank').textContent = (node.pagerank ?? 0).toFixed(4);
  document.getElementById('detail-degree').textContent   = node.degree ?? connectedEdges.length;
  document.getElementById('detail-edges-count').textContent = connectedEdges.length;

  const createdAt = node.raw?.createdAt ?? node.createdAt ?? null;
  const updatedAt = node.raw?.updatedAt ?? node.updatedAt ?? null;
  document.getElementById('detail-created').textContent = fmtTime(createdAt);
  document.getElementById('detail-updated').textContent = fmtTime(updatedAt);

  const rawPre = document.getElementById('raw-pre');
  rawPre.textContent = JSON.stringify(node.raw ?? node, null, 2);
}

function hideDetail() {
  selectedNodeId = null;
  $detail.classList.add('hidden');
}

// ── 事件绑定 ─────────────────────────────────────────────────────────────────

$pauseBtn.addEventListener('click', () => {
  isPaused = !isPaused;
  $pauseBtn.textContent = isPaused ? '▶ 继续' : '⏸ 暂停';
  $pauseBtn.classList.toggle('active', isPaused);
  if (!isPaused) {
    $statusBar.textContent = '● 实时监控中';
    $statusBar.classList.remove('fade');
    fetchGraph();
  } else {
    $statusBar.textContent = '已暂停';
  }
});

$forceBtn.addEventListener('click', () => reloadGraph());

document.getElementById('raw-toggle')?.addEventListener('click', () => {
  document.getElementById('raw-section')?.classList.toggle('visible');
});

// ── v2: 搜索 & 筛选事件 ───────────────────────────────────────────────────────

function onSearchInput() {
  clearTimeout(searchDebounce);
  const q = $searchBox.value;
  $searchClear.hidden = !q;
  searchDebounce = setTimeout(() => {
    filterState.search = q;
    highlightState = { nodeId: null, neighborIds: [] };
    applyVisuals();
  }, 200);
}

function onClearSearch() {
  $searchBox.value = '';
  $searchClear.hidden = true;
  filterState.search = '';
  highlightState = { nodeId: null, neighborIds: [] };
  applyVisuals();
}

function onTypeChange() {
  filterState.type = $typeFilter.value;
  highlightState = { nodeId: null, neighborIds: [] };
  applyVisuals();
}

function onSearchKeydown(e) {
  if (e.key === 'Escape') {
    if ($searchBox.value) {
      onClearSearch();
    } else {
      // 搜索框已空 → 清除高亮，还原 filterState
      highlightState = { nodeId: null, neighborIds: [] };
      applyVisuals();
    }
    e.target.blur();
  }
}

$searchBox.addEventListener('input', onSearchInput);
$searchBox.addEventListener('keydown', onSearchKeydown);
$searchClear.addEventListener('click', onClearSearch);
$typeFilter.addEventListener('change', onTypeChange);

// ── 删除功能 ────────────────────────────────────────────────────────────────

let _pendingDeleteId = null;

document.getElementById('delete-btn').addEventListener('click', () => {
  if (!selectedNodeId) return;
  const node = graphData?.nodes?.find(n => n.id === selectedNodeId);
  document.getElementById('delete-node-name').textContent = node?.label ?? selectedNodeId;
  document.getElementById('delete-modal').classList.remove('hidden');
  _pendingDeleteId = selectedNodeId;
});

document.getElementById('delete-cancel').addEventListener('click', () => {
  document.getElementById('delete-modal').classList.add('hidden');
  _pendingDeleteId = null;
});

document.getElementById('delete-confirm').addEventListener('click', async () => {
  const nodeId = _pendingDeleteId;
  if (!nodeId) return;

  document.getElementById('delete-modal').classList.add('hidden');

  try {
    const res = await fetch(`http://192.168.100.137:7824/api/nodes/${nodeId}`, { method: 'DELETE' });
    const json = await res.json();
    if (!res.ok || !json.ok) throw new Error(json.error || 'Delete failed');

    flashStatus(`已从数据库删除: ${nodeId}`);

    // 重新加载完整图谱数据（filterState 保留，highlightState 清除）
    highlightState = { nodeId: null, neighborIds: [] };
    await reloadGraph();
  } catch (err) {
    flashStatus(`删除失败: ${err.message}`);
  } finally {
    hideDetail();
  }

  _pendingDeleteId = null;
});

// ── 启动 ─────────────────────────────────────────────────────────────────────

(async () => {
  $statusBar.textContent = '加载中…';
  console.log('[Graph] starting, vis available:', typeof vis !== 'undefined');
  await fetchGraph();
  startPolling();
  $statusBar.textContent = '● 实时监控中';
})();
