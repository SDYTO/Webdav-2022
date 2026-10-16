import { useCallback, useEffect, useState } from "react";

/**
 * 路由只保留两类：文件夹浏览与回收站。
 * 其余（分享、站点、图床、设置、MCP 等）属于本项目已剥离的功能面。
 */
export type Route = { kind: "folder"; path: string } | { kind: "trash" };

function encodeRoute(route: Route): string {
  switch (route.kind) {
    case "folder":
      return `#/${route.path.split("/").map(encodeURIComponent).join("/")}`;
    case "trash":
      return "#/trash";
  }
}

function decodeRoute(hash: string): Route {
  const raw = hash.replace(/^#\/?/, "");
  if (raw === "trash") return { kind: "trash" };

  const path = raw
    .split("/")
    .filter(Boolean)
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    })
    .join("/");

  return { kind: "folder", path: path ? `${path}/` : "" };
}

function hashIsEmpty(hash: string) {
  return !hash || hash === "#" || hash === "#/";
}

/**
 * 分享链接可用 `?p=folder` 代替 `#/folder/`。
 * 把它映射到 hash 路由并去掉 `p`，让 hash 保持规范形式。
 */
function applyQueryPathToHash(): Route | null {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("p")) return null;

  const queryPath = url.searchParams.get("p") ?? "";
  const hashEmpty = hashIsEmpty(url.hash);

  url.searchParams.delete("p");

  if (!hashEmpty || !queryPath) {
    const next = `${url.pathname}${url.search}${url.hash}`;
    window.history.replaceState(null, "", next);
    return null;
  }

  const route = decodeRoute(`#/${queryPath.replace(/^\/+/, "")}`);
  const nextHash = encodeRoute(route);
  window.history.replaceState(null, "", `${url.pathname}${url.search}${nextHash}`);
  return route;
}

function resolveInitialRoute(): Route {
  return applyQueryPathToHash() ?? decodeRoute(window.location.hash);
}

export function useHashRoute(): [Route, (route: Route) => void] {
  const [route, setRoute] = useState<Route>(() => resolveInitialRoute());

  useEffect(() => {
    const onHashChange = () => setRoute(decodeRoute(window.location.hash));
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const navigate = useCallback((next: Route) => {
    const nextHash = encodeRoute(next);
    if (window.location.hash === nextHash) {
      setRoute(next);
      return;
    }
    window.location.hash = nextHash;
  }, []);

  return [route, navigate];
}
