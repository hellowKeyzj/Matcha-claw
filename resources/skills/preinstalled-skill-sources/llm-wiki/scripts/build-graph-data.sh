#!/bin/bash
# build-graph-data.sh — 扫描 wiki/ 生成交互式图谱所需的 graph-data.json
#
# 用法：bash scripts/build-graph-data.sh <wiki_root> [output_path]
#   wiki_root     包含 wiki/ 子目录的知识库根路径
#   output_path   可选，默认 <wiki_root>/wiki/graph-data.json
#
# 环境变量：
#   LLM_WIKI_TEST_MODE=1   启用稳定输出（nodes/edges 按 id 字典序 + 时间戳固定）
#
# 退出码：0 成功；1 路径/依赖错误；2 wiki 结构不完整

set -eu
shopt -s nullglob

SCRIPT_DIR="${BASH_SOURCE[0]%/*}"
[ "$SCRIPT_DIR" = "${BASH_SOURCE[0]}" ] && SCRIPT_DIR="."
SCRIPT_DIR="$(cd "$SCRIPT_DIR" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/shared-config.sh"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/runtime-context.sh"

WIKI_ROOT="${1:-.}"
DEFAULT_OUTPUT="$WIKI_ROOT/wiki/graph-data.json"
OUTPUT="${2:-$DEFAULT_OUTPUT}"
SKILL_DIR="$(resolve_skill_dir "$SCRIPT_DIR")"
HELPER="$SKILL_DIR/scripts/graph-analysis.js"
MAX_CONTENT_BYTES=$((2 * 1024 * 1024))
MAX_CONTENT_LINES=500
MAX_INSIGHT_NODES=250
MAX_INSIGHT_EDGES=1000

command -v node >/dev/null 2>&1 || {
  echo "ERROR: node is not installed. Install it via:" >&2
  print_install_hint node
  exit 1
}

[ -f "$HELPER" ] || {
  echo "ERROR: 找不到图谱分析 helper：$HELPER" >&2
  echo "       请确认 MatchaClaw 预装的 llm-wiki skill 包含完整 scripts/ 目录。" >&2
  exit 1
}

WIKI_DIR="$WIKI_ROOT/wiki"
[ -d "$WIKI_DIR" ] || {
  echo "ERROR: wiki 目录不存在：$WIKI_DIR" >&2
  echo "       请先运行 init-wiki.sh 初始化知识库。" >&2
  exit 2
}

TMPDIR=$(mktemp -d -t llm-wiki-graph.XXXXXX)
trap 'rm -rf "$TMPDIR"' EXIT

if [ "${LLM_WIKI_TEST_MODE:-0}" = "1" ]; then
  BUILD_DATE="2026-01-01T00:00:00Z"
else
  BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
fi

WIKI_TITLE=""
if [ -f "$WIKI_ROOT/purpose.md" ]; then
  WIKI_TITLE=$(awk '/^# / { sub(/^# +/, ""); print; exit }' "$WIKI_ROOT/purpose.md")
fi
[ -n "$WIKI_TITLE" ] || WIKI_TITLE=$(basename "$(cd "$WIKI_ROOT" && pwd)")

NODES_TSV="$TMPDIR/nodes.tsv"
: > "$NODES_TSV"

scan_kind() {
  local subdir="$1" type="$2"
  local dir="$WIKI_DIR/$subdir"
  [ -d "$dir" ] || return 0
  local f id label
  while IFS= read -r f; do
    [ -f "$f" ] || continue
    id=$(basename "$f" .md)
    case "$id" in
      index|log|purpose|.wiki-schema|README) continue ;;
    esac
    label=$(awk '/^# / { sub(/^# +/, ""); gsub(/[[:space:]]+$/, ""); print; exit }' "$f")
    [ -n "$label" ] || label="$id"
    printf '%s\t%s\t%s\t%s\n' "$id" "$label" "$type" "$f" >> "$NODES_TSV"
  done < <(find "$dir" -type f -name '*.md' | LC_ALL=C sort)
}

scan_kind entities entity
scan_kind topics topic
scan_kind sources source
scan_kind comparisons comparison
scan_kind synthesis synthesis
scan_kind queries query

if [ ! -s "$NODES_TSV" ]; then
  mkdir -p "$(dirname "$OUTPUT")"
  OUTPUT_TMP="$TMPDIR/graph-data.empty.json"
  node "$HELPER" empty-graph "$OUTPUT_TMP" "$BUILD_DATE" "$WIKI_TITLE" "$MAX_INSIGHT_NODES" "$MAX_INSIGHT_EDGES"
  mv "$OUTPUT_TMP" "$OUTPUT"
  echo "空图谱已写入：${OUTPUT}（wiki/ 下无可纳入节点）"
  exit 0
fi

EDGES_RAW="$TMPDIR/edges_raw.tsv"
: > "$EDGES_RAW"

while IFS=$'\t' read -r id label type path; do
  awk -v src="$id" '
    {
      line = $0
      conf = ""
      if (match(line, /<!--[[:space:]]*confidence:[[:space:]]*[A-Z]+[[:space:]]*-->/)) {
        kind_str = substr(line, RSTART, RLENGTH)
        if (match(kind_str, /[A-Z]+/)) {
          conf = substr(kind_str, RSTART, RLENGTH)
        }
      }
      rest = line
      while (match(rest, /\[\[[^]]+\]\]/)) {
        inner = substr(rest, RSTART + 2, RLENGTH - 4)
        rest  = substr(rest, RSTART + RLENGTH)
        n = index(inner, "|")
        if (n > 0) inner = substr(inner, 1, n - 1)
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", inner)
        if (inner == "" || inner == src) continue
        print src "\t" NR "\t" inner "\t" conf
      }
    }
  ' "$path" >> "$EDGES_RAW"
done < "$NODES_TSV"

VALID_IDS="$TMPDIR/valid_ids.txt"
cut -f1 "$NODES_TSV" | sort -u > "$VALID_IDS"

EDGES_TSV="$TMPDIR/edges.tsv"
# 合并同一 from+to 的多条 raw edges：
#   - 第一次遇到时记录（有 conf 就用 conf，无 conf 就留空 → 最终默认 EXTRACTED）
#   - 后续遇到带显式 conf 的条目时 **升级**（覆盖之前的空值或 EXTRACTED 默认）
#   - 若后续遇到多条不同的非空 conf，保留首个非空（按首次显式标注优先）
#
# 这解决了"同一对节点被多次 [[]] 引用（正文 + 相关页面列表）时，
#  首次出现的空 conf 会永久锁定 edge type 为 EXTRACTED"的问题。
awk -F'\t' -v valids="$VALID_IDS" '
  BEGIN {
    while ((getline line < valids) > 0) valid[line] = 1
    close(valids)
  }
  {
    from = $1; to = $3; conf = $4
    if (!(to in valid)) next
    if (from == to) next
    key = from "\t" to
    if (!(key in seen)) {
      seen[key] = 1
      saved_conf[key] = conf  # 可能为空，在 END 中兜底为 EXTRACTED
      order[++count] = key
    } else if (conf != "" && saved_conf[key] == "") {
      # 升级：之前未见显式 conf（留空），现在有，采用
      saved_conf[key] = conf
    }
  }
  END {
    for (i = 1; i <= count; i++) {
      split(order[i], parts, "\t")
      t = saved_conf[order[i]]
      if (t != "EXTRACTED" && t != "INFERRED" && t != "AMBIGUOUS") t = "EXTRACTED"
      print parts[1] "\t" parts[2] "\t" t
    }
  }
' "$EDGES_RAW" > "$EDGES_TSV"

TOTAL_SIZE=0
while IFS=$'\t' read -r id label type path; do
  sz=$(wc -c < "$path" 2>/dev/null || echo 0)
  TOTAL_SIZE=$((TOTAL_SIZE + sz))
done < "$NODES_TSV"

DEGRADE=0
if [ "$TOTAL_SIZE" -gt "$MAX_CONTENT_BYTES" ]; then
  DEGRADE=1
fi

TEST_MODE=0
if [ "${LLM_WIKI_TEST_MODE:-0}" = "1" ]; then
  TEST_MODE=1
fi

if command -v cygpath >/dev/null 2>&1; then
  NODES_NATIVE_TSV="$TMPDIR/nodes.native.tsv"
  : > "$NODES_NATIVE_TSV"
  while IFS=$'\t' read -r id label type path; do
    printf '%s\t%s\t%s\t%s\n' "$id" "$label" "$type" "$(cygpath -m "$path")" >> "$NODES_NATIVE_TSV"
  done < "$NODES_TSV"
  NODES_INPUT_TSV="$NODES_NATIVE_TSV"
else
  NODES_INPUT_TSV="$NODES_TSV"
fi

node "$HELPER" prepare-inputs \
  "$NODES_INPUT_TSV" \
  "$EDGES_TSV" \
  "$TMPDIR/nodes.raw.json" \
  "$TMPDIR/edges.raw.json" \
  "$TEST_MODE"

ANALYSIS_JSON="$TMPDIR/analysis.json"
if ! node "$HELPER" \
  "$TMPDIR/nodes.raw.json" \
  "$TMPDIR/edges.raw.json" \
  "$ANALYSIS_JSON" \
  "$DEGRADE" \
  "$MAX_CONTENT_LINES" \
  "$MAX_INSIGHT_NODES" \
  "$MAX_INSIGHT_EDGES"; then
  echo "ERROR: 图谱分析 helper 执行失败：$HELPER" >&2
  exit 1
fi

mkdir -p "$(dirname "$OUTPUT")"
OUTPUT_TMP="$TMPDIR/graph-data.final.json"
ASSEMBLE_STATS="$TMPDIR/assemble.stats"

if ! node "$HELPER" assemble-graph \
  "$ANALYSIS_JSON" \
  "$OUTPUT_TMP" \
  "$BUILD_DATE" \
  "$WIKI_TITLE" \
  "$DEGRADE" \
  "$TEST_MODE" > "$ASSEMBLE_STATS"; then
  echo "ERROR: 图谱数据组装失败：$HELPER" >&2
  exit 1
fi

mv "$OUTPUT_TMP" "$OUTPUT"

NODE_COUNT=0
EDGE_COUNT=0
INITIAL_VIEW_COUNT=0
INSIGHTS_DEGRADED=false
while IFS='=' read -r key value; do
  case "$key" in
    node_count) NODE_COUNT="$value" ;;
    edge_count) EDGE_COUNT="$value" ;;
    initial_view_count) INITIAL_VIEW_COUNT="$value" ;;
    insights_degraded) INSIGHTS_DEGRADED="$value" ;;
  esac
done < "$ASSEMBLE_STATS"

echo "图谱数据已生成：$OUTPUT"
echo "  节点：$NODE_COUNT"
echo "  关联：$EDGE_COUNT"
echo "  初始视图：$INITIAL_VIEW_COUNT 个节点"
[ "$DEGRADE" = "1" ] && echo "  ⚠ 降级模式：内嵌内容 > 2MB，每节点仅保留前 ${MAX_CONTENT_LINES} 行"
[ "$INSIGHTS_DEGRADED" = "true" ] && echo "  ⚠ 洞察降级：图规模超出预算，仅保留基础权重与社区"
exit 0
