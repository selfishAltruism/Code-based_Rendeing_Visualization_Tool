"use client";

import React, { useMemo } from "react";

import { buildGraphFromMappingResult } from "@/shared/libs/buildGraph/buildGraph";

interface RenderGraphSvgProps {
  mappingResult: Mapping.MappingResult | null;
  svgRef: React.RefObject<SVGSVGElement | null>;
}

// buildGraphFromMappingResult 반환 타입 재사용
type GraphLayout = ReturnType<typeof buildGraphFromMappingResult>;
type GraphNode = GraphLayout["nodes"][number];
type GraphEdge = GraphLayout["edges"][number];

/**
 * JSX 노드들을
 * - depth(부모-자식 관계) 기준으로 가로 방향
 * - 같은 depth 내에서는 형제 순서대로 세로 방향
 * 으로 재배치
 *
 * 전제:
 *   - JSX 노드: node.kind === "jsx"
 *   - 부모 관계: node.meta?.jsxParentId (string | undefined)
 */
function applyJsxTreeLayout(layout: GraphLayout): GraphLayout {
  const { nodes, edges, width, height, colX } = layout;

  // JSX 노드만 추출
  const jsxNodes = nodes.filter((n: GraphNode) => n.kind === "jsx");
  if (!jsxNodes.length) {
    return layout;
  }

  // 부모 ID 정보 수집 (없으면 루트 취급)
  const parentIdMap = new Map<string, string | undefined>();
  for (const node of jsxNodes) {
    const meta = node.meta as { jsxParentId?: string } | undefined;
    parentIdMap.set(node.id, meta?.jsxParentId);
  }

  // JSX 노드 id → node 매핑
  const jsxNodeById = new Map<string, GraphNode>();
  for (const node of jsxNodes) {
    jsxNodeById.set(node.id, node);
  }

  // 루트 JSX 노드: 부모가 없거나, 부모가 JSX 노드 목록에 없는 경우
  const rootJsxNodes = jsxNodes.filter((node) => {
    const parentId = parentIdMap.get(node.id);
    return !parentId || !jsxNodeById.has(parentId);
  });

  // depth / rowIndex 계산용 맵
  const depthById = new Map<string, number>();
  const rowIndexByDepth = new Map<number, number>();

  // DFS로 순회하면서
  // - depth 할당
  // - depth별 y 인덱스를 증가시키며 rowIndex 지정
  function dfs(node: GraphNode, depth: number) {
    depthById.set(node.id, depth);

    const currentRow = rowIndexByDepth.get(depth) ?? 0;
    rowIndexByDepth.set(depth, currentRow + 1);

    // 이 노드의 자식 JSX 노드들
    const children = jsxNodes.filter((child) => {
      const parentId = parentIdMap.get(child.id);
      return parentId === node.id;
    });

    for (const child of children) {
      dfs(child, depth + 1);
    }
  }

  // 루트들부터 DFS
  for (const root of rootJsxNodes) {
    dfs(root, 0);
  }

  // 최대 depth 계산
  let maxDepth = 0;
  for (const d of depthById.values()) {
    if (d > maxDepth) maxDepth = d;
  }

  // X/Y 배치 파라미터
  const baseX = colX.jsx; // JSX 컬럼 중심
  const depthGapX = 160; // depth 간 가로 간격
  const baseY = 80; // JSX 영역 시작 Y
  const rowGapY = 40; // 행 간 세로 간격

  // JSX 노드의 새 좌표 계산 (중심 기준 x/y)
  const newNodePositions = new Map<string, { x: number; y: number }>();

  // depth / row 별 y 인덱스 재계산용 맵 초기화
  const usedRowsPerDepth = new Map<number, number>();

  function assignPosition(node: GraphNode, depth: number) {
    const used = usedRowsPerDepth.get(depth) ?? 0;
    usedRowsPerDepth.set(depth, used + 1);

    const x =
      baseX -
      (maxDepth * depthGapX) / 2 + // 전체 트리를 JSX 중앙 기준으로 좌우로 분산
      depth * depthGapX;

    const y = baseY + used * rowGapY;

    newNodePositions.set(node.id, { x, y });

    // 자식에 대해서도 재귀
    const children = jsxNodes.filter((child) => {
      const parentId = parentIdMap.get(child.id);
      return parentId === node.id;
    });

    for (const child of children) {
      assignPosition(child, depth + 1);
    }
  }

  // 루트부터 다시 한 번 좌표 할당
  usedRowsPerDepth.clear();
  for (const root of rootJsxNodes) {
    assignPosition(root, 0);
  }

  // 노드 좌표 갱신
  const newNodes: GraphNode[] = nodes.map((node) => {
    const pos = newNodePositions.get(node.id);
    if (!pos) return node;

    return {
      ...node,
      x: pos.x,
      y: pos.y,
    };
  });

  // edge 좌표도 JSX 노드 기준으로 덮어쓰기
  const nodeByIdAfter = new Map<string, GraphNode>();
  for (const node of newNodes) {
    nodeByIdAfter.set(node.id, node);
  }

  const newEdges: GraphEdge[] = edges.map((edge) => {
    const fromNodeId = edge.from.nodeId as string | undefined;
    const toNodeId = edge.to.nodeId as string | undefined;

    let newFrom = edge.from;
    let newTo = edge.to;

    if (fromNodeId && nodeByIdAfter.has(fromNodeId)) {
      const n = nodeByIdAfter.get(fromNodeId)!;
      newFrom = {
        ...edge.from,
        x: n.x,
        y: n.y,
      };
    }

    if (toNodeId && nodeByIdAfter.has(toNodeId)) {
      const n = nodeByIdAfter.get(toNodeId)!;
      newTo = {
        ...edge.to,
        x: n.x,
        y: n.y,
      };
    }

    return {
      ...edge,
      from: newFrom,
      to: newTo,
    };
  });

  // 높이/너비 보정 (JSX 트리가 기존 영역을 넘어갈 수 있으므로)
  let maxY = height;
  for (const node of newNodes) {
    const bottom = node.y + node.height / 2 + 40;
    if (bottom > maxY) maxY = bottom;
  }

  let maxX = width;
  for (const node of newNodes) {
    const right = node.x + node.width / 2 + 40;
    if (right > maxX) maxX = right;
  }

  return {
    nodes: newNodes,
    edges: newEdges,
    width: maxX,
    height: maxY,
    colX,
  };
}

/**
 * 두 점 사이를 부드러운 S자 곡선으로 연결하는 path 생성
 */
function buildCurvePath(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): string {
  const mx = (x1 + x2) / 2;
  const dy = y2 - y1;
  const offset = Math.max(Math.min(dy * 0.3, 80), -80);

  const c1x = mx;
  const c1y = y1 + offset;
  const c2x = mx;
  const c2y = y2 - offset;

  return `M ${x1} ${y1} C ${c1x} ${c1y} ${c2x} ${c2y} ${x2} ${y2}`;
}

/**
 * edge 종류별 스타일
 */
function getEdgeStyle(kind: BuildGraph.GraphEdgeKind): {
  stroke: string;
  dashed?: boolean;
  markerId: string;
} {
  switch (kind) {
    case "flow":
      return {
        stroke: "#8b5cf6", // 보라 계열
        dashed: true,
        markerId: "arrow-solid",
      };
    case "state-dependency":
      return {
        stroke: "#9ca3af", // 회색
        dashed: true,
        markerId: "arrow-muted",
      };
    case "state-mutation":
      return {
        stroke: "#b91c1c", // 붉은 계열
        dashed: false,
        markerId: "arrow-accent",
      };
    case "external":
    default:
      return {
        stroke: "#6b7280",
        dashed: true,
        markerId: "arrow-muted",
      };
  }
}

export function RenderGraphSvg({ mappingResult, svgRef }: RenderGraphSvgProps) {
  const { nodes, edges, width, height, colX } = useMemo(() => {
    const base = buildGraphFromMappingResult(mappingResult);
    // JSX 영역 트리 레이아웃 적용
    return applyJsxTreeLayout(base);
  }, [mappingResult]);

  if (!mappingResult) {
    return <div className="text-sm text-neutral-500">코드 분석 결과 없음.</div>;
  }

  if (!nodes.length) {
    return (
      <div className="text-sm text-neutral-500">
        분석 가능한 노드가 없습니다.
      </div>
    );
  }

  return (
    <div className="h-full w-full overflow-auto rounded-md border bg-white">
      <svg ref={svgRef} width={width} height={height} className="block">
        {/* defs: arrow marker 정의 */}
        <defs>
          {/* 기본 흐름 화살표 */}
          <marker
            id="arrow-solid"
            markerWidth="8"
            markerHeight="8"
            refX="7"
            refY="4"
            orient="auto"
            markerUnits="strokeWidth"
          >
            <path d="M0,0 L8,4 L0,8 z" fill="#8b5cf6" />
          </marker>

          {/* muted 화살표 */}
          <marker
            id="arrow-muted"
            markerWidth="8"
            markerHeight="8"
            refX="7"
            refY="4"
            orient="auto"
            markerUnits="strokeWidth"
          >
            <path d="M0,0 L8,4 L0,8 z" fill="#9ca3af" />
          </marker>

          {/* 상태 변경 강조 화살표 */}
          <marker
            id="arrow-accent"
            markerWidth="8"
            markerHeight="8"
            refX="7"
            refY="4"
            orient="auto"
            markerUnits="strokeWidth"
          >
            <path d="M0,0 L8,4 L0,8 z" fill="#b91c1c" />
          </marker>
        </defs>

        {/* 컬럼 타이틀 */}
        <g fontSize={11} fill="#4b5563">
          <text x={colX.independent} y={40} textAnchor="middle">
            렌더링 독립
          </text>
          <text x={colX.state} y={40} textAnchor="middle">
            렌더링 결정 / 상태
          </text>
          <text x={colX.variable} y={40} textAnchor="middle">
            변수 / 헬퍼
          </text>
          <text x={colX.effect} y={40} textAnchor="middle">
            렌더링 후속
          </text>
          <text x={colX.jsx} y={40} textAnchor="middle">
            JSX
          </text>
        </g>

        {/* edge (곡선) */}
        <g>
          {edges.map((edge) => {
            const style = getEdgeStyle(edge.kind);
            const d = buildCurvePath(
              edge.from.x,
              edge.from.y,
              edge.to.x,
              edge.to.y,
            );

            const midX = (edge.from.x + edge.to.x) / 2;
            const midY = (edge.from.y + edge.to.y) / 2;

            return (
              <g key={edge.id}>
                <path
                  d={d}
                  fill="none"
                  stroke={style.stroke}
                  strokeWidth={1}
                  strokeDasharray={style.dashed ? "3 2" : undefined}
                  markerEnd={`url(#${style.markerId})`}
                />
                {edge.label && (
                  <text
                    x={midX}
                    y={midY - 4}
                    fontSize={9}
                    textAnchor="middle"
                    fill={style.stroke}
                  >
                    {edge.label}
                  </text>
                )}
              </g>
            );
          })}
        </g>

        {/* nodes */}
        <g>
          {nodes.map((node) => {
            const radius = 6;
            const rectX = node.x - node.width / 2;
            const rectY = node.y - node.height / 2;

            let fill = "#ffffff";
            let stroke = "#d1d5db";

            switch (node.kind) {
              case "independent":
                stroke = "#6b7280";
                break;
              case "state":
                stroke = "#2563eb";
                fill = "#eff6ff";
                break;
              case "effect":
                stroke = "#8b5cf6";
                fill = "#f5f3ff";
                break;
              case "jsx":
                stroke = "#0f766e";
                fill = "#ecfdf5";
                break;
              case "external":
                stroke = "#9ca3af";
                fill = "#f9fafb";
                break;
              case "variable":
              default:
                stroke = "#9ca3af";
                fill = "#ffffff";
                break;
            }

            return (
              <g key={node.id}>
                <rect
                  x={rectX}
                  y={rectY}
                  rx={radius}
                  ry={radius}
                  width={node.width}
                  height={node.height}
                  fill={fill}
                  stroke={stroke}
                  strokeWidth={1}
                />
                <text
                  x={node.x}
                  y={node.y + 3}
                  fontSize={11}
                  textAnchor="middle"
                  fill="#111827"
                >
                  {node.label}
                </text>
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}
