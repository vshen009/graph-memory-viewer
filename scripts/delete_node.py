#!/usr/bin/env python3
"""从知识图谱数据库真正删除一个节点"""
import sys, sqlite3, json, os

DB_PATH = "/home/trinity/.openclaw/graph-memory.db"
GRAPH_JSON = os.path.join(os.path.dirname(__file__), "../data/graph.json")

def delete_node(node_id):
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()

    # 1. 删关联边（双向）
    cur.execute("DELETE FROM gm_edges WHERE from_id=? OR to_id=?", (node_id, node_id))
    edges_deleted = cur.rowcount

    # 2. 删节点
    cur.execute("DELETE FROM gm_nodes WHERE id=?", (node_id,))
    nodes_deleted = cur.rowcount

    conn.commit()
    conn.close()

    # 3. 重新导出 graph.json
    export_graph()
    return edges_deleted, nodes_deleted

def export_graph():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    nodes = cur.execute("""
        SELECT id, type, name, description, content, status,
               community_id, pagerank, created_at, updated_at
        FROM gm_nodes WHERE status='active'
    """).fetchall()

    edges = cur.execute("""
        SELECT id, from_id, to_id, type, instruction, condition, session_id
        FROM gm_edges
    """).fetchall()

    communities = cur.execute("SELECT id, summary, node_count, created_at, updated_at FROM gm_communities").fetchall()

    graph = {
        "nodes": [
            {
                "id": n["id"],
                "type": n["type"],
                "label": n["name"],
                "description": n["description"],
                "content": n["content"],
                "status": n["status"],
                "communityId": n["community_id"],
                "pagerank": n["pagerank"],
                "createdAt": n["created_at"],
                "updatedAt": n["updated_at"],
            }
            for n in nodes
        ],
        "edges": [
            {
                "id": e["id"],
                "source": e["from_id"],
                "target": e["to_id"],
                "label": e["type"],
                "instruction": e["instruction"],
                "condition": e["condition"],
            }
            for e in edges
        ],
        "communities": [
            {**dict(c)} for c in communities
        ],
    }

    with open(GRAPH_JSON, "w", encoding="utf-8") as f:
        json.dump(graph, f, ensure_ascii=False, indent=2)

    conn.close()

if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: delete_node.py <node_id>")
        sys.exit(1)

    node_id = sys.argv[1]
    edges_d, nodes_d = delete_node(node_id)
    print(f"OK: deleted {nodes_d} node(s), {edges_d} edge(s)")
