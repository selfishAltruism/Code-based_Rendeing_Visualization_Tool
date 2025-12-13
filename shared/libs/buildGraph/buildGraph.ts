/**
 * 컬럼 x 위치 구성
 */
function buildColumnX(): BuildGraph.GraphLayout["colX"] {
  const base = 80;
  const gap = 220;

  return {
    independent: base,
    state: base + gap,
    variable: base + gap * 2,
    effect: base + gap * 3,
    jsx: base + gap * 4,
  };
}

/**
 * y 위치 배치 헬퍼
 */
function layoutColumnNodes<
  T extends { id: string; label: string; meta?: Record<string, unknown> },
>(
  items: T[],
  kind: BuildGraph.GraphNodeKind,
  x: number,
  startY: number,
  gapY: number,
): BuildGraph.GraphNode[] {
  return items.map((item, index) => {
    const y = startY + index * gapY;
    return {
      id: `${kind}-${item.id}`,
      label: item.label,
      kind,
      x,
      y,
      width: 120,
      height: 32,
      meta: item.meta,
    };
  });
}

/**
 * 분석 결과 → 그래프 레이아웃
 */
export function buildGraphFromMappingResult(
  mappingResult: Mapping.MappingResult | null,
): BuildGraph.GraphLayout {
  if (!mappingResult) {
    const colX = buildColumnX();
    return {
      nodes: [],
      edges: [],
      width: colX.jsx + 200,
      height: 800,
      colX,
    };
  }

  const colX = buildColumnX();
  const nodes: BuildGraph.GraphNode[] = [];
  const edges: BuildGraph.GraphEdge[] = [];

  // 1. 독립 노드 (useRef)
  const independentItems = mappingResult.hooks
    .filter((h) => h.hookKind === "useRef")
    .map((h) => ({
      id: h.id,
      label: h.name,
      meta: {
        hookKind: h.hookKind,
        scope: h.scope,
      } as Record<string, unknown>,
    }));

  const independentNodes = layoutColumnNodes(
    independentItems,
    "independent",
    colX.independent,
    80,
    50,
  );
  nodes.push(...independentNodes);

  // 2. 상태 노드 (useState + 전역 상태)
  const stateItems = mappingResult.hooks
    .filter((h) => ["useState", "zustand", "react-query"].includes(h.hookKind))
    .map((h) => ({
      id: h.id,
      label: h.scope === "global" ? `${h.name} (global)` : h.name,
      meta: {
        hookKind: h.hookKind,
        scope: h.scope,
      } as Record<string, unknown>,
    }));

  const stateNodes = layoutColumnNodes(stateItems, "state", colX.state, 80, 40);
  nodes.push(...stateNodes);

  // 2.5 변수/헬퍼 노드 (currentFloor, siblingFloors 등)
  const variableItems = (mappingResult.variables ?? []).map((v) => ({
    id: v.id,
    label: v.name,
    meta: { dependencies: v.dependencies } as Record<string, unknown>,
  }));

  const variableNodes = layoutColumnNodes(
    variableItems,
    "variable",
    colX.variable,
    80,
    40,
  );
  nodes.push(...variableNodes);

  // state/ref/variable -> variable (렌더링 단계 계산 의존성)
  (mappingResult.variables ?? []).forEach((v) => {
    const varNode = variableNodes.find((n) => n.id === `variable-${v.id}`);
    if (!varNode) return;

    v.dependencies.forEach((depName) => {
      const fromRef = independentNodes.find((n) => n.label === depName);
      const fromState = stateNodes.find((n) => n.label.startsWith(depName));
      const fromVar = variableNodes.find((n) => n.label === depName);

      const fromNode = fromRef ?? fromState ?? fromVar;
      if (!fromNode) return;

      edges.push({
        id: `var-dep-${fromNode.id}-${varNode.id}-${depName}`,
        from: {
          nodeId: fromNode.id,
          x: fromNode.x + fromNode.width / 2,
          y: fromNode.y,
        },
        to: {
          nodeId: varNode.id,
          x: varNode.x - varNode.width / 2,
          y: varNode.y,
        },
        kind: "state-dependency",
        label: depName,
      });
    });
  });

  // 3. effect / callback 노드
  const effectItems = [
    ...mappingResult.effects.map((e) => ({
      id: e.id,
      label: e.hookKind,
      meta: {
        type: "effect",
        ...e,
      } as Record<string, unknown>,
    })),
    ...mappingResult.callbacks.map((cb) => ({
      id: cb.id,
      label: cb.name ?? "callback",
      meta: {
        type: "callback",
        ...cb,
      } as Record<string, unknown>,
    })),
  ];

  const effectNodes = layoutColumnNodes(
    effectItems,
    "effect",
    colX.effect,
    80,
    40,
  );
  nodes.push(...effectNodes);

  // 4. JSX 노드 (depth 기반 컬럼 + 형제 세로 배치)
  type JsxLayoutItem = {
    id: string;
    label: string;
    depth: number;
    props: string[];
    refProps: string[];
    parentId?: string | null;
  };

  const jsxLayoutItems: JsxLayoutItem[] = mappingResult.jsxNodes.map((jsx) => ({
    id: jsx.id, // 논리 JSX id
    label: jsx.component,
    depth: jsx.depth,
    props: jsx.props,
    refProps: jsx.refProps ?? [],
    parentId: jsx.parentId ?? null,
  }));

  const jsxNodes: BuildGraph.GraphNode[] = [];

  // depth별로 그룹핑
  const jsxByDepth = new Map<number, JsxLayoutItem[]>();
  jsxLayoutItems.forEach((item) => {
    const arr = jsxByDepth.get(item.depth) ?? [];
    arr.push(item);
    jsxByDepth.set(item.depth, arr);
  });

  // JSX 트리 레이아웃 파라미터
  const jsxBaseX = colX.jsx; // depth=0 컬럼 기준
  const depthGapX = 160; // depth 증가 시 가로 이동량

  const jsxBaseY = 80;
  const depthGapY = 80; // depth 간 세로 오프셋
  const intraGapY = 32; // 같은 depth 내 형제 간 세로 간격

  Array.from(jsxByDepth.entries())
    .sort((a, b) => a[0] - b[0])
    .forEach(([depth, items]) => {
      items.forEach((item, index) => {
        const x = jsxBaseX + depth * depthGapX;
        const y = jsxBaseY + depth * depthGapY + index * intraGapY;

        const node: BuildGraph.GraphNode = {
          id: `jsx-${item.id}`,
          label: item.label,
          kind: "jsx",
          x,
          y,
          width: 120,
          height: 32,
          meta: {
            depth: item.depth,
            props: item.props,
            refProps: item.refProps,
            jsxParentId: item.parentId ? `jsx-${item.parentId}` : undefined,
          } as Record<string, unknown>,
        };

        jsxNodes.push(node);
      });
    });

  nodes.push(...jsxNodes);

  /**
   * 단순 flow 연결 헬퍼
   */
  function connectSequential(
    fromNodes: BuildGraph.GraphNode[],
    toNodes: BuildGraph.GraphNode[],
    label?: string,
  ): void {
    fromNodes.forEach((from, index) => {
      const to = toNodes[index] ?? toNodes[toNodes.length - 1];
      if (!to) return;

      edges.push({
        id: `flow-${from.id}-${to.id}`,
        from: {
          nodeId: from.id,
          x: from.x + from.width / 2,
          y: from.y,
        },
        to: {
          nodeId: to.id,
          x: to.x - to.width / 2,
          y: to.y,
        },
        kind: "flow",
        label,
      });
    });
  }

  // state / ref → effect (의존성)
  mappingResult.effects.forEach((effect) => {
    const effectNode = effectNodes.find((n) => n.id === `effect-${effect.id}`);
    if (!effectNode) return;

    // 1) state → effect (기존 로직 그대로 유지)
    effect.dependencies.forEach((dep) => {
      const stateNode = stateNodes.find((n) => n.label.startsWith(dep.name));
      if (!stateNode) return;

      edges.push({
        id: `dep-${stateNode.id}-${effectNode.id}-${dep.name}`,
        from: {
          nodeId: stateNode.id,
          x: stateNode.x + stateNode.width / 2,
          y: stateNode.y,
        },
        to: {
          nodeId: effectNode.id,
          x: effectNode.x - effectNode.width / 2,
          y: effectNode.y,
        },
        kind: "state-dependency",
        label: dep.name,
      });
    });

    // 2) ref → effect (ref 읽기 의존성)
    const refReads = effect.refReads as string[] | undefined;
    refReads?.forEach((refName) => {
      const refNode = independentNodes.find((n) => n.label === refName);
      if (!refNode) return;

      edges.push({
        id: `dep-ref-${refNode.id}-${effectNode.id}-${refName}`,
        from: {
          nodeId: refNode.id,
          x: refNode.x + refNode.width / 2,
          y: refNode.y,
        },
        to: {
          nodeId: effectNode.id,
          x: effectNode.x - effectNode.width / 2,
          y: effectNode.y,
        },
        kind: "state-dependency",
        label: refName,
      });
    });

    // 3) effect → state (setState, 기존 로직)
    effect.setters.forEach((setter) => {
      const match = setter.match(/^set([A-Z].*)/);
      const stateName = match
        ? match[1].charAt(0).toLowerCase() + match[1].slice(1)
        : setter;

      const stateNode = stateNodes.find((n) => n.label.startsWith(stateName));
      if (!stateNode) return;

      edges.push({
        id: `mut-${effectNode.id}-${stateNode.id}-${setter}`,
        from: {
          nodeId: effectNode.id,
          x: effectNode.x + effectNode.width / 2,
          y: effectNode.y,
        },
        to: {
          nodeId: stateNode.id,
          x: stateNode.x - stateNode.width / 2,
          y: stateNode.y,
        },
        kind: "state-mutation",
        label: setter,
      });
    });

    // 4) effect → ref (ref.current 쓰기)
    const refWrites = effect.refWrites as string[] | undefined;
    refWrites?.forEach((refName) => {
      const refNode = independentNodes.find((n) => n.label === refName);
      if (!refNode) return;

      edges.push({
        id: `mut-ref-${effectNode.id}-${refNode.id}-${refName}`,
        from: {
          nodeId: effectNode.id,
          x: effectNode.x + effectNode.width / 2,
          y: effectNode.y,
        },
        to: {
          nodeId: refNode.id,
          x: refNode.x - refNode.width / 2,
          y: refNode.y,
        },
        kind: "state-mutation",
        label: refName,
      });
    });
  });

  // callback → state-mutation
  mappingResult.callbacks.forEach((cb) => {
    const cbNode = effectNodes.find((n) => n.id === `effect-${cb.id}`);
    if (!cbNode) return;

    cb.setters.forEach((setter) => {
      const match = setter.match(/^set([A-Z].*)/);
      const stateName = match
        ? match[1].charAt(0).toLowerCase() + match[1].slice(1)
        : setter;

      const stateNode = stateNodes.find((n) => n.label.startsWith(stateName));
      if (!stateNode) return;

      edges.push({
        id: `cb-mut-${cbNode.id}-${stateNode.id}-${setter}`,
        from: {
          nodeId: cbNode.id,
          x: cbNode.x + cbNode.width / 2,
          y: cbNode.y,
        },
        to: {
          nodeId: stateNode.id,
          x: stateNode.x - stateNode.width / 2,
          y: stateNode.y,
        },
        kind: "state-mutation",
        label: setter,
      });
    });
  });

  // state / ref ↔ JSX prop (ref attribute 방향 포함)
  jsxNodes.forEach((jsxNode) => {
    const jsxMeta = jsxNode.meta ?? {};
    const ownProps = (jsxMeta.props as string[]) ?? [];
    const refProps = (jsxMeta.refProps as string[]) ?? [];

    // 조상 props까지 합산(조건/맵 렌더 영향 전파)
    const allPropsSet = new Set<string>(ownProps);

    let cursorParentId = (jsxMeta as { jsxParentId?: string }).jsxParentId;
    while (cursorParentId) {
      const parent = jsxNodes.find((n) => n.id === cursorParentId);
      if (!parent) break;

      const pm = parent.meta ?? {};
      const pp = (pm.props as string[]) ?? [];
      const pr = (pm.refProps as string[]) ?? [];
      pp.filter((p) => !pr.includes(p)).forEach((p) => allPropsSet.add(p)); // refProps 제외하고 전파

      cursorParentId = (pm as { jsxParentId?: string }).jsxParentId;
    }

    const props = Array.from(allPropsSet);

    props.forEach((name) => {
      const refNode = independentNodes.find((n) => n.label === name);
      const stateNode = stateNodes.find((n) => n.label.startsWith(name));
      const isRefAttr = refProps.includes(name);
      const variableNode = variableNodes.find((n) => n.label === name);

      // 1) JSX element에서 ref attribute로 ref를 연결한 경우
      //    div -> wrapperRef (JSX → ref, mutation 성격)
      if (refNode && isRefAttr) {
        edges.push({
          id: `jsx-ref-attr-${jsxNode.id}-${refNode.id}-${name}`,
          from: {
            nodeId: jsxNode.id,
            x: jsxNode.x + jsxNode.width / 2,
            y: jsxNode.y,
          },
          to: {
            nodeId: refNode.id,
            x: refNode.x - refNode.width / 2,
            y: refNode.y,
          },
          kind: "state-mutation",
          label: name,
        });
        return;
      }

      // 2) JSX element에서 ref attribute를 제외한 prop으로 ref를 받는 경우
      //    wrapperRef -> MapFloorContextMenu (ref → JSX, dependency)
      if (refNode && !isRefAttr) {
        edges.push({
          id: `jsx-ref-prop-${refNode.id}-${jsxNode.id}-${name}`,
          from: {
            nodeId: refNode.id,
            x: refNode.x + refNode.width / 2,
            y: refNode.y,
          },
          to: {
            nodeId: jsxNode.id,
            x: jsxNode.x - jsxNode.width / 2,
            y: jsxNode.y,
          },
          kind: "state-dependency",
          label: name,
        });
        return;
      }

      if (variableNode) {
        edges.push({
          id: `jsx-prop-var-${variableNode.id}-${jsxNode.id}-${name}`,
          from: {
            nodeId: variableNode.id,
            x: variableNode.x + variableNode.width / 2,
            y: variableNode.y,
          },
          to: {
            nodeId: jsxNode.id,
            x: jsxNode.x - jsxNode.width / 2,
            y: jsxNode.y,
          },
          kind: "state-dependency",
          label: name,
        });
      }

      // 3) 일반 state / 변수 → JSX prop (기존 로직)
      if (stateNode) {
        edges.push({
          id: `jsx-prop-${stateNode.id}-${jsxNode.id}-${name}`,
          from: {
            nodeId: stateNode.id,
            x: stateNode.x + stateNode.width / 2,
            y: stateNode.y,
          },
          to: {
            nodeId: jsxNode.id,
            x: jsxNode.x - jsxNode.width / 2,
            y: jsxNode.y,
          },
          kind: "state-dependency",
          label: name,
        });
      }
    });
  });

  const width = colX.jsx + 200;
  const lastJsxY = jsxNodes.length ? jsxNodes[jsxNodes.length - 1].y : 600;
  const height = lastJsxY + 120;

  // JSX 부모–자식 관계 edge 추가
  // mappingResult.jsxNodes의 id / parentId (논리 id)를
  // 그래프 노드 id(`jsx-${logicalId}`)로 매핑하여 연결
  const jsxNodeMap = new Map<string, BuildGraph.GraphNode>();
  jsxNodes.forEach((node) => {
    // node.id는 "jsx-" + logicalId 이므로, prefix 제거해서 역매핑
    const logicalId = node.id.replace(/^jsx-/, "");
    jsxNodeMap.set(logicalId, node);
  });

  mappingResult.jsxNodes.forEach((jsx) => {
    if (!jsx.parentId) return; // 루트 JSX는 부모 없음

    const parentNode = jsxNodeMap.get(jsx.parentId);
    const childNode = jsxNodeMap.get(jsx.id);
    if (!parentNode || !childNode) return;

    edges.push({
      id: `jsx-tree-${parentNode.id}-${childNode.id}`,
      from: {
        nodeId: parentNode.id,
        x: parentNode.x + parentNode.width / 2,
        y: parentNode.y,
      },
      to: {
        nodeId: childNode.id,
        x: childNode.x - childNode.width / 2,
        y: childNode.y,
      },
      // 기존 타입을 유지하기 위해 kind는 "flow"로 두고,
      // JSX 계층 관계라는 정보는 meta 쪽에 담는 것도 가능
      kind: "flow",
      label: undefined,
    });
  });

  return {
    nodes,
    edges,
    width,
    height,
    colX,
  };
}
