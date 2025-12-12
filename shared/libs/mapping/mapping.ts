// libs/mapping.ts
import { parse } from "@babel/parser";
import traverse, { type NodePath } from "@babel/traverse";
import * as t from "@babel/types";

/**
 * 소스 → AST
 */
function parseSourceToAst(source: string): t.File {
  return parse(source, {
    sourceType: "module",
    plugins: ["jsx", "typescript"],
  });
}

/**
 * export 정보 수집
 */
interface ExportInfo {
  defaultExport: string | null;
  namedExports: string[];
}

function collectExportedComponents(ast: t.File): ExportInfo {
  const info: ExportInfo = {
    defaultExport: null,
    namedExports: [],
  };

  traverse(ast, {
    ExportDefaultDeclaration(path: NodePath<t.ExportDefaultDeclaration>) {
      const decl = path.node.declaration;
      if (t.isIdentifier(decl)) {
        info.defaultExport = decl.name;
      } else if (t.isFunctionDeclaration(decl) && decl.id) {
        info.defaultExport = decl.id.name;
      }
    },
    ExportNamedDeclaration(path: NodePath<t.ExportNamedDeclaration>) {
      const decl = path.node.declaration;
      if (t.isFunctionDeclaration(decl) && decl.id) {
        info.namedExports.push(decl.id.name);
      }
      path.node.specifiers.forEach((spec) => {
        if (t.isExportSpecifier(spec) && t.isIdentifier(spec.exported)) {
          info.namedExports.push(spec.exported.name);
        }
      });
    },
  });

  return info;
}

/**
 * 주요 컴포넌트 선택
 */
function pickPrimaryComponent(
  exportInfo: ExportInfo,
  fileName?: string,
): string | null {
  if (exportInfo.defaultExport) return exportInfo.defaultExport;
  if (exportInfo.namedExports.length === 1) return exportInfo.namedExports[0];

  if (fileName) {
    const base = fileName.replace(/\.[^/.]+$/, "");
    const matched = exportInfo.namedExports.find((name) => name === base);
    if (matched) return matched;
  }

  return exportInfo.namedExports[0] ?? null;
}

/**
 * 훅 이름 → HookKind
 */
function classifyHookKind(
  calleeName: string,
  importSource: string | null,
): Mapping.HookKind {
  if (calleeName === "useState") return "useState";
  if (calleeName === "useRef") return "useRef";
  if (calleeName === "useReducer") return "useReducer";
  if (calleeName === "useEffect") return "useEffect";
  if (calleeName === "useLayoutEffect") return "useLayoutEffect";
  if (calleeName === "useCallback") return "useCallback";
  if (calleeName === "useMemo") return "useMemo";

  // Zustand 추정
  if (
    calleeName.startsWith("use") &&
    calleeName.endsWith("Store") &&
    importSource &&
    importSource.includes("zustand")
  ) {
    return "zustand";
  }

  // React Query 추정
  if (
    importSource &&
    (importSource.includes("reactQuery") ||
      importSource.includes("@tanstack/react-query"))
  ) {
    const lower = calleeName.toLowerCase();
    if (lower.includes("mutation")) return "react-query";
    if (lower.includes("query")) return "react-query";
  }

  return "custom";
}

/**
 * import 맵
 */
interface ImportMap {
  [localName: string]: string;
}

function collectImportMap(ast: t.File): ImportMap {
  const map: ImportMap = {};

  ast.program.body.forEach((node) => {
    if (t.isImportDeclaration(node)) {
      const src = node.source.value;
      node.specifiers.forEach(
        (
          spec:
            | t.ImportSpecifier
            | t.ImportDefaultSpecifier
            | t.ImportNamespaceSpecifier,
        ) => {
          if (
            t.isImportSpecifier(spec) ||
            t.isImportDefaultSpecifier(spec) ||
            t.isImportNamespaceSpecifier(spec)
          ) {
            if (t.isIdentifier(spec.local)) {
              map[spec.local.name] = src;
            }
          }
        },
      );
    }
  });

  return map;
}

/**
 * path.get(key) 결과를 단일 NodePath로 정리하는 헬퍼
 * (NodePath | NodePath[] → NodePath | null)
 */
function getSingleSubPath(
  path: NodePath<t.Node>,
  key: string,
): NodePath<t.Node> | null {
  const sub = path.get(key) as NodePath<t.Node> | NodePath<t.Node>[];
  if (Array.isArray(sub)) {
    return sub[0] ?? null;
  }
  return sub;
}

/**
 * useEffect / useLayoutEffect 분석
 */
function analyzeEffectCall(
  path: NodePath<t.CallExpression>,
  effectId: string,
  hookKind: "useEffect" | "useLayoutEffect",
  globalStateNames: Set<string>,
): Mapping.AnalyzedEffect {
  const node = path.node;
  const loc = node.loc;

  const dependencies: Mapping.EffectDependency[] = [];
  const setters: string[] = [];
  const refReads: string[] = [];
  const refWrites: string[] = [];

  const args = path.get("arguments") as NodePath<t.Expression>[];
  const cbArgPath = args[0];
  const depsArgPath = args[1];

  // deps 배열 추출
  if (depsArgPath && depsArgPath.isArrayExpression()) {
    depsArgPath.node.elements.forEach((el) => {
      if (t.isIdentifier(el)) {
        dependencies.push({
          name: el.name,
          isGlobal: globalStateNames.has(el.name),
        });
      }
    });
  }

  // effect callback 내부 분석
  if (
    cbArgPath &&
    (cbArgPath.isArrowFunctionExpression() || cbArgPath.isFunctionExpression())
  ) {
    const bodyPathNode = getSingleSubPath(
      cbArgPath as unknown as NodePath<t.Node>,
      "body",
    );

    if (
      bodyPathNode &&
      (bodyPathNode.isBlockStatement() || bodyPathNode.isExpression())
    ) {
      bodyPathNode.traverse({
        // setXxx, queryClient.mutate 등 setter 수집
        CallExpression(innerPath: NodePath<t.CallExpression>) {
          const innerCallee = innerPath.node.callee;

          if (
            t.isIdentifier(innerCallee) &&
            /^set[A-Z]/.test(innerCallee.name)
          ) {
            setters.push(innerCallee.name);
          }

          if (
            t.isMemberExpression(innerCallee) &&
            t.isIdentifier(innerCallee.property) &&
            (innerCallee.property.name === "mutate" ||
              innerCallee.property.name === "mutateAsync")
          ) {
            const obj = innerCallee.object;
            if (t.isIdentifier(obj)) {
              setters.push(`${obj.name}.${innerCallee.property.name}`);
            }
          }
        },

        // ref 읽기 / 쓰기 구분
        MemberExpression(innerPath: NodePath<t.MemberExpression>) {
          const obj = innerPath.node.object;
          if (!t.isIdentifier(obj) || !obj.name.endsWith("Ref")) return;

          const parent = innerPath.parentPath?.node;

          // ref.current = ... 형태: 쓰기
          if (
            t.isAssignmentExpression(parent) &&
            parent.left === innerPath.node
          ) {
            refWrites.push(obj.name);
          } else {
            // 그 외: 읽기 (조건, 대입, 함수 인자 등)
            refReads.push(obj.name);
          }
        },
      });
    }
  }

  return {
    id: effectId,
    hookKind,
    dependencies,
    setters: Array.from(new Set(setters)),
    refReads: Array.from(new Set(refReads)),
    refWrites: Array.from(new Set(refWrites)),
    definedAt: loc ? { line: loc.start.line, column: loc.start.column } : null,
  };
}

/**
 * useCallback 분석
 */
function analyzeUseCallbackCall(
  path: NodePath<t.CallExpression>,
  callbackId: string,
): Mapping.AnalyzedCallback {
  const node = path.node;
  const loc = node.loc;

  const args = path.get("arguments") as NodePath<t.Expression>[];
  const cbArgPath = args[0];
  const depsArgPath = args[1];

  const dependencies: string[] = [];
  const setters: string[] = [];

  if (depsArgPath && depsArgPath.isArrayExpression()) {
    depsArgPath.node.elements.forEach((el) => {
      if (t.isIdentifier(el)) {
        dependencies.push(el.name);
      }
    });
  }

  if (
    cbArgPath &&
    (cbArgPath.isArrowFunctionExpression() || cbArgPath.isFunctionExpression())
  ) {
    const bodyPathNode = getSingleSubPath(
      cbArgPath as unknown as NodePath<t.Node>,
      "body",
    );

    if (
      bodyPathNode &&
      (bodyPathNode.isBlockStatement() || bodyPathNode.isExpression())
    ) {
      bodyPathNode.traverse({
        CallExpression(innerPath: NodePath<t.CallExpression>) {
          const innerCallee = innerPath.node.callee;
          if (
            t.isIdentifier(innerCallee) &&
            /^set[A-Z]/.test(innerCallee.name)
          ) {
            setters.push(innerCallee.name);
          }
        },
      });
    }
  }

  let cbName: string | null = null;
  const parent = path.parentPath;
  if (parent.isVariableDeclarator() && t.isIdentifier(parent.node.id)) {
    cbName = parent.node.id.name;
  }

  return {
    id: callbackId,
    name: cbName,
    dependencies: Array.from(new Set(dependencies)),
    setters: Array.from(new Set(setters)),
    definedAt: loc ? { line: loc.start.line, column: loc.start.column } : null,
  };
}

/**
 * JSX 트리 분석
 * - 현재 구조를 유지하되, parentId와 depth를 스택 기반으로 계산
 */
function analyzeJsxTree(
  rootPath: NodePath<t.Node>,
  result: Mapping.AnalyzedJsxNode[],
): void {
  function getJsxName(node: t.JSXOpeningElement | t.JSXClosingElement): string {
    const name = node.name;

    if (t.isJSXIdentifier(name)) return name.name;

    if (t.isJSXMemberExpression(name)) {
      const parts: string[] = [];
      let current: t.JSXMemberExpression | t.JSXIdentifier = name;

      while (t.isJSXMemberExpression(current)) {
        if (t.isJSXIdentifier(current.property)) {
          parts.unshift(current.property.name);
        }
        if (t.isJSXIdentifier(current.object)) {
          parts.unshift(current.object.name);
          break;
        }
        current = current.object as t.JSXMemberExpression | t.JSXIdentifier;
      }
      return parts.join(".");
    }

    if (t.isJSXNamespacedName(name)) {
      const ns = t.isJSXIdentifier(name.namespace) ? name.namespace.name : "ns";
      const id = t.isJSXIdentifier(name.name) ? name.name.name : "name";
      return `${ns}:${id}`;
    }

    return "Unknown";
  }

  // JSX 부모 추적용 스택: 현재 열려 있는 JSX 노드의 id들을 저장
  const jsxStack: string[] = [];

  rootPath.traverse({
    JSXElement: {
      enter(path: NodePath<t.JSXElement>) {
        const opening = path.node.openingElement;
        const loc = opening.loc;

        // props 안에서 Identifier / MemberExpression(wrapperRef.current) 추출 + ref attribute 구분
        const propIdentifiers: string[] = [];
        const refAttrIdentifiers: string[] = [];

        opening.attributes.forEach(
          (attr: t.JSXAttribute | t.JSXSpreadAttribute) => {
            if (!t.isJSXAttribute(attr)) return;
            if (!t.isJSXIdentifier(attr.name)) return;

            const attrName = attr.name.name;
            const value = attr.value;
            if (!t.isJSXExpressionContainer(value)) return;

            const expr = value.expression;
            let baseName: string | null = null;

            if (t.isIdentifier(expr)) {
              // 예: ref={wrapperRef}, wrapperElement={wrapperRef}
              baseName = expr.name;
            } else if (
              t.isMemberExpression(expr) &&
              t.isIdentifier(expr.object)
            ) {
              // 예: wrapperElement={wrapperRef.current}
              baseName = expr.object.name;
            }

            if (!baseName) return;

            propIdentifiers.push(baseName);

            // ref attribute 인 경우만 별도 리스트에 기록
            if (attrName === "ref") {
              refAttrIdentifiers.push(baseName);
            }
          },
        );

        // 현재 depth는 스택 길이
        const depth = jsxStack.length;
        const parentId =
          jsxStack.length > 0 ? jsxStack[jsxStack.length - 1] : null;

        // 새로운 JSX 노드 id 생성
        const id = `jsx-${result.length + 1}`;

        result.push({
          id,
          component: getJsxName(opening),
          depth,
          parentId,
          props: Array.from(new Set(propIdentifiers)),
          refProps: Array.from(new Set(refAttrIdentifiers)),
          definedAt: loc
            ? { line: loc.start.line, column: loc.start.column }
            : null,
        });

        // 지금 들어온 노드를 스택에 push → 이후 자식 JSX의 parentId가 됨
        jsxStack.push(id);
      },

      exit() {
        // 이 JSXElement가 끝날 때 스택에서 pop
        jsxStack.pop();
      },
    },
  });
}

/**
 * 컴포넌트 body 내부 분석
 */
function analyzeComponentBody(
  ast: t.File,
  primaryComponentName: string | null,
  importMap: ImportMap,
): {
  hooks: Mapping.AnalyzedHook[];
  effects: Mapping.AnalyzedEffect[];
  callbacks: Mapping.AnalyzedCallback[];
  jsxNodes: Mapping.AnalyzedJsxNode[];
  calledVariableNames: string[];
  variables: Mapping.AnalyzedVariable[];
} {
  const hooks: Mapping.AnalyzedHook[] = [];
  const effects: Mapping.AnalyzedEffect[] = [];
  const callbacks: Mapping.AnalyzedCallback[] = [];
  const jsxNodes: Mapping.AnalyzedJsxNode[] = [];
  const variables: Mapping.AnalyzedVariable[] = [];

  const globalStateNames = new Set<string>();

  // 1단계: 함수 호출된 변수 이름을 모을 Set
  const calledVariableNames = new Set<string>();

  function isPrimaryComponent(
    path: NodePath<t.FunctionDeclaration> | NodePath<t.VariableDeclarator>,
  ): boolean {
    if (!primaryComponentName) return false;

    if (path.isFunctionDeclaration()) {
      return Boolean(
        path.node.id && path.node.id.name === primaryComponentName,
      );
    }

    if (path.isVariableDeclarator()) {
      return (
        t.isIdentifier(path.node.id) &&
        path.node.id.name === primaryComponentName
      );
    }

    return false;
  }

  function inspectFunctionBody(bodyPath: NodePath<t.BlockStatement>): void {
    analyzeJsxTree(bodyPath as unknown as NodePath<t.Node>, jsxNodes);

    // ★ helper variable deps 수집 유틸
    function collectExprDeps(exprPath: NodePath<t.Node>): string[] {
      const deps = new Set<string>();

      exprPath.traverse({
        Identifier(p: NodePath<t.Identifier>) {
          const parent = p.parent;

          // obj.prop 의 prop(비계산) / { key: value }의 key 등은 제외
          if (
            t.isMemberExpression(parent) &&
            parent.property === p.node &&
            parent.computed === false
          ) {
            return;
          }
          if (
            t.isObjectProperty(parent) &&
            parent.key === p.node &&
            parent.computed === false
          ) {
            return;
          }

          deps.add(p.node.name);
        },

        MemberExpression(p: NodePath<t.MemberExpression>) {
          // wrapperRef.current -> wrapperRef도 deps로 넣고 싶으면 object를 추가
          if (t.isIdentifier(p.node.object)) {
            deps.add(p.node.object.name);
          }
        },
      });

      return Array.from(deps);
    }

    // ★ 컴포넌트 body 최상위 variable 선언만 수집
    const topLevelStatements = bodyPath.get("body") as NodePath<t.Statement>[];
    topLevelStatements.forEach((stmtPath) => {
      if (!stmtPath.isVariableDeclaration()) return;

      const decls = stmtPath.get(
        "declarations",
      ) as NodePath<t.VariableDeclarator>[];
      decls.forEach((declPath) => {
        const id = declPath.node.id;
        const init = declPath.node.init;

        // 이름이 단일 식별자인 경우만 (currentFloor, siblingFloors)
        if (!t.isIdentifier(id)) return;
        if (!init) return;

        // 훅/콜백 선언은 제외 (useState/useRef..., ()=>{} 등)
        if (t.isCallExpression(init) && t.isIdentifier(init.callee)) {
          const localName = init.callee.name;
          const source = importMap[localName] ?? null;
          const kind = classifyHookKind(localName, source);
          if (kind !== "custom") return; // useState/useRef/.../zustand/react-query 제외
        }
        if (t.isArrowFunctionExpression(init) || t.isFunctionExpression(init))
          return;

        const initPath = declPath.get("init") as NodePath<t.Node>;
        const deps = collectExprDeps(initPath).filter((n) => n !== id.name);

        const loc = declPath.node.loc;
        variables.push({
          id: `var-${variables.length + 1}`,
          name: id.name,
          dependencies: deps,
          definedAt: loc
            ? { line: loc.start.line, column: loc.start.column }
            : null,
        });
      });
    });

    bodyPath.traverse({
      VariableDeclarator(varPath: NodePath<t.VariableDeclarator>) {
        const init = varPath.node.init;
        if (!t.isCallExpression(init)) return;

        const callee = init.callee;
        if (!t.isIdentifier(callee)) return;

        const localName = callee.name;
        const source = importMap[localName] ?? null;
        const hookKind = classifyHookKind(localName, source);

        const loc = init.loc;
        const id = varPath.node.id;

        const names: string[] = [];
        if (t.isIdentifier(id)) {
          names.push(id.name);
        } else if (t.isArrayPattern(id)) {
          id.elements.forEach((el) => {
            if (t.isIdentifier(el)) {
              names.push(el.name);
            }
          });
        } else if (t.isObjectPattern(id)) {
          id.properties.forEach((prop) => {
            if (t.isObjectProperty(prop) && t.isIdentifier(prop.value)) {
              names.push(prop.value.name);
            }
          });
        }

        const scope: Mapping.StateScope =
          hookKind === "zustand" || hookKind === "react-query"
            ? "global"
            : "local";

        names.forEach((name) => {
          const hook: Mapping.AnalyzedHook = {
            id: `hook-${hooks.length + 1}`,
            name,
            hookKind,
            scope,
            definedAt: loc
              ? { line: loc.start.line, column: loc.start.column }
              : null,
            meta: { importSource: source },
          };
          hooks.push(hook);

          if (scope === "global") {
            globalStateNames.add(name);
          }
        });
      },

      CallExpression(callPath: NodePath<t.CallExpression>) {
        const callee = callPath.node.callee;
        if (!t.isIdentifier(callee)) return;

        const localName = callee.name;

        // 1단계: 이 변수가 실제로 () 호출된 것임을 기록
        calledVariableNames.add(localName);

        // 기존 hookKind 분석 로직은 그대로 유지
        const source = importMap[localName] ?? null;
        const hookKind = classifyHookKind(localName, source);

        if (hookKind === "useEffect" || hookKind === "useLayoutEffect") {
          const effectId = `effect-${effects.length + 1}`;
          const effect = analyzeEffectCall(
            callPath,
            effectId,
            hookKind,
            globalStateNames,
          );
          effects.push(effect);
        }

        if (hookKind === "useCallback") {
          const callbackId = `callback-${callbacks.length + 1}`;
          const cb = analyzeUseCallbackCall(callPath, callbackId);
          callbacks.push(cb);
        }
      },
    });
  }

  traverse(ast, {
    FunctionDeclaration(path: NodePath<t.FunctionDeclaration>) {
      if (!isPrimaryComponent(path)) return;

      const bodyPathNode = getSingleSubPath(
        path as unknown as NodePath<t.Node>,
        "body",
      );
      if (bodyPathNode && bodyPathNode.isBlockStatement()) {
        inspectFunctionBody(
          bodyPathNode as unknown as NodePath<t.BlockStatement>,
        );
      }
    },

    VariableDeclarator(path: NodePath<t.VariableDeclarator>) {
      if (!isPrimaryComponent(path)) return;

      const init = path.node.init;
      if (t.isArrowFunctionExpression(init) || t.isFunctionExpression(init)) {
        const initPath = path.get("init") as NodePath<
          t.ArrowFunctionExpression | t.FunctionExpression
        >;

        const bodyPathNode = getSingleSubPath(
          initPath as unknown as NodePath<t.Node>,
          "body",
        );

        if (bodyPathNode && bodyPathNode.isBlockStatement()) {
          inspectFunctionBody(
            bodyPathNode as unknown as NodePath<t.BlockStatement>,
          );
        } else if (bodyPathNode && bodyPathNode.isExpression()) {
          analyzeJsxTree(bodyPathNode as unknown as NodePath<t.Node>, jsxNodes);
        }
      }
    },
  });

  return {
    hooks,
    effects,
    callbacks,
    jsxNodes,
    calledVariableNames: Array.from(calledVariableNames),
    variables,
  };
}

/**
 * 엔트리 함수
 */
export function mapping(
  source: string,
  fileName?: string,
): Mapping.MappingResult {
  const ast = parseSourceToAst(source);
  const importMap = collectImportMap(ast);
  const exportInfo = collectExportedComponents(ast);
  const primaryComponentName = pickPrimaryComponent(exportInfo, fileName);

  const {
    hooks,
    effects,
    callbacks,
    jsxNodes,
    calledVariableNames,
    variables,
  } = analyzeComponentBody(ast, primaryComponentName, importMap);

  const errors: string[] = [];

  return {
    source,
    fileName,
    componentName: primaryComponentName,
    hooks,
    effects,
    callbacks,
    jsxNodes,
    variables,
    meta: {
      exportedComponents: exportInfo.namedExports,
      defaultExport: exportInfo.defaultExport,
    },
    errors,
    calledVariableNames,
  };
}
