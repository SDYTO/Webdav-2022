import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

/**
 * 访问模型：只读免密，写操作需口令。
 *
 * 因此这里不再有"未登录就挡住整个应用"的逻辑：
 *   - 匿名访问者 → 随便浏览、下载、搜索；
 *   - 任何写请求（上传 / 新建文件夹 / 重命名 / 移动 / 删除 / 回收站操作）
 *     在发出前先本地拦一道：没凭据就直接抛 401 并通知界面弹出口令输入框，
 *     既省一次注定失败的往返，也不会让用户看到莫名其妙的错误。
 */

export interface Credentials {
  username: string;
  password: string;
}

const STORAGE_KEY = "flaredrive.auth";

/** 写方法集合。 */
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
/**
 * 例外：这两个端点用 POST 但只做只读的事（统计、打包下载），
 * 匿名访问者必须能用，所以不参与写保护。
 */
const PUBLIC_POST_PATHS = ["/api/counts", "/api/archive"];
/** 登录校验端点本身也要放行。 */
const AUTH_PATH = "/api/auth";

let current: Credentials | null = load();
const listeners = new Set<() => void>();
const authRequiredListeners = new Set<() => void>();

function load(): Credentials | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Credentials) : null;
  } catch {
    return null;
  }
}

function persist(credentials: Credentials | null) {
  try {
    if (credentials) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(credentials));
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // ignore persistence failures
  }
}

function emit() {
  for (const listener of listeners) listener();
}

/** 通知界面"需要口令"，用于自动弹出登录框。 */
function emitAuthRequired() {
  for (const listener of authRequiredListeners) listener();
}

export function subscribeAuthRequired(listener: () => void) {
  authRequiredListeners.add(listener);
  return () => {
    authRequiredListeners.delete(listener);
  };
}

export function getCredentials() {
  return current;
}

export function isAdmin() {
  return current !== null;
}

export function setCredentials(credentials: Credentials) {
  current = credentials;
  persist(credentials);
  emit();
}

export function clearCredentials() {
  current = null;
  persist(null);
  emit();
}

export function utf8ToBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export function basicAuthHeader() {
  if (!current) return undefined;
  return `Basic ${utf8ToBase64(`${current.username}:${current.password}`)}`;
}

function pathOf(input: RequestInfo | URL, init: RequestInit): string {
  const raw =
    typeof input === "string"
      ? input
      : input instanceof URL
      ? input.pathname
      : input.url;
  try {
    return new URL(raw, window.location.origin).pathname;
  } catch {
    return raw || (init.method || "").toString();
  }
}

function methodOf(input: RequestInfo | URL, init: RequestInit): string {
  if (init.method) return init.method.toUpperCase();
  if (typeof input === "object" && "method" in input) {
    return (input.method || "GET").toUpperCase();
  }
  return "GET";
}

/**
 * 统一请求入口。所有 API 调用都应经它发出，以便：
 *  1. 自动附带 Basic 口令；
 *  2. 写请求在无凭据时本地短路（返回 401 并唤起口令输入）。
 */
export async function authFetch(
  input: RequestInfo | URL,
  init: RequestInit = {}
) {
  const path = pathOf(input, init);
  const method = methodOf(input, init);
  const needsAuth =
    WRITE_METHODS.has(method) &&
    path !== AUTH_PATH &&
    !PUBLIC_POST_PATHS.includes(path);

  if (needsAuth && !current) {
    emitAuthRequired();
    return new Response(
      JSON.stringify({ error: "写操作需要管理口令" }),
      {
        status: 401,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      }
    );
  }

  const headers = new Headers(init.headers || {});
  const authorization = basicAuthHeader();
  if (authorization) headers.set("Authorization", authorization);

  const response = await fetch(input, { ...init, headers });
  // 口令已失效（例如服务端轮换过）：清掉本地凭据并提示重新输入。
  if (response.status === 401 && current) {
    clearCredentials();
    emitAuthRequired();
  }
  return response;
}

export function subscribeAuth(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

interface AuthContextValue {
  username: string | null;
  isAdmin: boolean;
  login: (credentials: Credentials) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue>({
  username: null,
  isAdmin: false,
  login: () => {},
  logout: () => {},
});

export function useAuth() {
  return useContext(AuthContext);
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [username, setUsername] = useState<string | null>(
    current?.username ?? null
  );

  useEffect(
    () =>
      subscribeAuth(() => {
        setUsername(current?.username ?? null);
      }),
    []
  );

  const login = useCallback((credentials: Credentials) => {
    setCredentials(credentials);
  }, []);

  const logout = useCallback(() => {
    clearCredentials();
  }, []);

  const value = useMemo(
    () => ({ username, isAdmin: username !== null, login, logout }),
    [username, login, logout]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
