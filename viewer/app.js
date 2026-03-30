/**
 * app.js – graph-memory-viewer
 * vis-network based, 5-second polling, detail panel.
 */

'use strict';

// ── 配置 ────────────────────────────────────────────────────────────────────

const CONFIG = {
  dataUrl:      '../data/graph.json',
  pollInterval: 5_000,
  typeColors: {
    task:    '#16a34a',
    skill:   '#2563eb',
    event:   '#ea580c',
    unknown: '#94a3b8',
  },
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
const $detail    = document.getElementById('detail-panel');
const $pauseBtn  = document.getElementById('pause-btn');
const $forceBtn  = document.getElementById('force-btn');
const $statusBar = document.getElementById('status-bar');

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
  return `${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}:${d.getSeconds().toString().padStart(2,'0')}`;
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
  const nodes = data.nodes.map(n => ({
    id:     n.id,
    label:  n.label,
    title:  n.description || n.label,
    color: {
      background: nodeColor(n.type),
      border:     nodeColor(n.type),
      highlight: { background: '#fff', border: nodeColor(n.type) },
      hover:     { background: nodeColor(n.type), border: '#fff' },
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
    color: { color: edgeColor(e.label), highlight: '#38bdf8' },
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
      showNodeDetail(params.nodes[0]);
    } else {
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

// ── 顶部统计栏 ────────────────────────────────────────────────────────────────

function updateStats(meta) {
  if ($stats.nodes)      $stats.nodes.textContent      = meta?.nodeCount ?? 0;
  if ($stats.edges)      $stats.edges.textContent      = meta?.edgeCount ?? 0;
  if ($stats.communities) $stats.communities.textContent = meta?.communityCount ?? 0;
  if ($stats.messages)   $stats.messages.textContent   = meta?.messageCount ?? 0;
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
  const typeColor = nodeColor(node.type);
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

$forceBtn.addEventListener('click', () => fetchGraph());

document.getElementById('raw-toggle')?.addEventListener('click', () => {
  document.getElementById('raw-section')?.classList.toggle('visible');
});

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

  // 从本地数据中移除节点（临时，后续接后端 API）
  if (graphData) {
    graphData.nodes = graphData.nodes.filter(n => n.id !== nodeId);
    graphData.edges = graphData.edges.filter(e => e.source !== nodeId && e.target !== nodeId);
  }

  hideDetail();
  flashStatus(`已删除节点: ${nodeId}`);

  // 重新渲染图谱
  if (graphData) {
    const vd = buildVisData(graphData);
    if (network) {
      network.setData(vd);
      network.setOptions({ physics: { enabled: true, stabilization: { iterations: 30 } } });
      clearTimeout(physicsTimer);
      physicsTimer = setTimeout(disablePhysics, 4000);
    }
    updateStats(graphData.meta);
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
