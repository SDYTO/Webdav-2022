import {
  Alert,
  Box,
  Button,
  CircularProgress,
  CssBaseline,
  Snackbar,
  Stack,
  ThemeProvider,
  useMediaQuery,
} from "@mui/material";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import BrandingDialog from "./BrandingDialog";
import Header from "./Header";
import LoginDialog from "./LoginDialog";
import LoginGate from "./LoginGate";
import Main from "./Main";
import TransferManager from "./TransferManager";
import {
  AuthProvider,
  basicAuthHeader,
  clearCredentials,
  subscribeAuthRequired,
  useAuth,
} from "./app/auth";
import { loadBranding } from "./app/branding";
import { installThumbnailCacheCleanup } from "./app/thumbnailCache";
import { ClipboardProvider } from "./app/clipboard";
import { NoticeAction, NoticeOptions, NoticeSeverity, NotifyFn } from "./app/notify";
import { strings, translate, useLang } from "./app/strings";
import {
  SortPref,
  ThemeModePreference,
  usePersistedState,
  ViewMode,
} from "./app/prefs";
import { useHashRoute } from "./app/route";
import { MOTION, Z_INDEX, createAppTheme } from "./app/theme";
import { TransferQueueProvider, useTransferQueue } from "./app/transferQueue";

export interface SnackbarMessage {
  key: number;
  message: string;
  severity: NoticeSeverity;
  action?: NoticeAction;
  duration?: number;
}

export function enqueueSnack(
  queue: SnackbarMessage[],
  next: SnackbarMessage
): SnackbarMessage[] {
  if (next.severity === "error") {
    return [...queue, next];
  }
  return [next, ...queue.filter((s) => s.severity === "error")];
}

const DEFAULT_SNACK_MS = 5000;
const ERROR_SNACK_MS = 8000;

function isTypingTarget(target: EventTarget | null) {
  const el =
    target instanceof HTMLElement
      ? target
      : document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  if (!el) return false;
  const field = el.closest("input, textarea, select, [contenteditable='true']");
  if (field instanceof HTMLInputElement) {
    return !["checkbox", "radio", "button", "submit"].includes(field.type);
  }
  if (field instanceof HTMLTextAreaElement || field instanceof HTMLSelectElement) {
    return true;
  }
  return Boolean(field) || el.isContentEditable;
}

function AppContent({
  themeMode,
  onThemeModeChange,
}: {
  themeMode: ThemeModePreference;
  onThemeModeChange: (mode: ThemeModePreference) => void;
}) {
  useLang();
  const { username, isAdmin, logout } = useAuth();
  const transferQueue = useTransferQueue();

  // 登录门禁：主站内容只有管理员登录后才渲染。
  // - guest：显示全屏登录页，主界面与全部数据请求都不存在；
  // - checking：本地有历史凭据，先经 /api/auth 校验，期间也不渲染任何内容；
  // - ok：校验通过（或本次登录成功），才挂载主界面。
  const [sessionState, setSessionState] = useState<"checking" | "ok" | "guest">(
    username ? "checking" : "guest"
  );

  useEffect(() => {
    if (!isAdmin) {
      setSessionState("guest");
      return;
    }
    let cancelled = false;
    setSessionState("checking");
    (async () => {
      try {
        const authorization = basicAuthHeader();
        const response = await fetch("/api/auth", {
          headers: authorization ? { Authorization: authorization } : {},
        });
        if (cancelled) return;
        if (response.ok) {
          setSessionState("ok");
        } else {
          // 缓存的凭据已失效（口令轮换过）：清掉并回到登录页。
          clearCredentials();
          setSessionState("guest");
        }
      } catch {
        if (!cancelled) setSessionState("guest");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isAdmin]);

  const [route, navigate] = useHashRoute();
  const [search, setSearch] = useState("");
  const [showTransfers, setShowTransfers] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const [brandingOpen, setBrandingOpen] = useState(false);
  const [contentScrolled, setContentScrolled] = useState(false);
  const [snackQueue, setSnackQueue] = useState<SnackbarMessage[]>([]);
  const [snackOpen, setSnackOpen] = useState(false);
  const snackKeyRef = useRef(0);
  const currentSnack = snackQueue[0] ?? null;
  const [view, setView] = usePersistedState<ViewMode>("flaredrive.view", "grid");
  const [sort, setSort] = usePersistedState<SortPref>("flaredrive.sort", {
    field: "name",
    order: "asc",
  });
  const searchInputRef = useRef<HTMLInputElement>(null);
  const notified = useRef(new Set<string>());
  const shownSnackKeyRef = useRef<number | null>(null);

  const pushSnack = useCallback(
    (snack: Omit<SnackbarMessage, "key">) => {
      snackKeyRef.current += 1;
      const next = { ...snack, key: snackKeyRef.current };
      setSnackQueue((queue) => enqueueSnack(queue, next));
    },
    []
  );

  // 写请求被本地拦下、或口令失效时，自动弹出口令输入框。
  useEffect(
    () =>
      subscribeAuthRequired(() => {
        setLoginOpen(true);
        pushSnack({
          message: translate("readOnlyBanner"),
          severity: "info",
        });
      }),
    [pushSnack]
  );

  useEffect(() => {
    if (snackOpen || snackQueue.length === 0) return;
    const head = snackQueue[0];
    if (shownSnackKeyRef.current === head.key) return;
    shownSnackKeyRef.current = head.key;
    setSnackOpen(true);
  }, [snackOpen, snackQueue]);

  useEffect(() => {
    transferQueue.forEach((task) => {
      if (notified.current.has(task.id)) return;
      if (task.status === "completed") {
        notified.current.add(task.id);
        pushSnack({
          message: translate("uploadedToast", { name: task.name }),
          severity: "success",
        });
      } else if (task.status === "failed") {
        notified.current.add(task.id);
        pushSnack({
          message: translate("uploadFailedToast", { name: task.name }),
          severity: "error",
          action: { label: translate("transfers"), onClick: () => setShowTransfers(true) },
        });
      }
    });
  }, [transferQueue, pushSnack]);

  const onNotify: NotifyFn = useCallback(
    (message, severity = "info", options?: NoticeOptions) => {
      pushSnack({
        message,
        severity,
        action: options?.action,
        duration: options?.duration ?? (severity === "error" ? ERROR_SNACK_MS : undefined),
      });
    },
    [pushSnack]
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.key === "Process") return;
      if (isTypingTarget(event.target) || isTypingTarget(document.activeElement)) {
        return;
      }
      const focusSearch =
        event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey;
      if (focusSearch) {
        event.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // 登录门禁分流：未通过校验前，Header / Main / 传输面板一概不挂载。
  if (sessionState !== "ok") {
    if (sessionState === "checking") {
      return (
        <Box
          sx={{
            minHeight: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: "background.default",
          }}
        >
          <CircularProgress aria-label={strings.loading} />
        </Box>
      );
    }
    return <LoginGate />;
  }

  return (
    <Stack sx={{ height: "100%", minHeight: 0, overflow: "hidden", backgroundColor: "background.default" }}>
      <Button
        href="#main-content"
        sx={{
          position: "absolute",
          left: 16,
          top: -48,
          zIndex: Z_INDEX.dragOverlay,
          transition: `top ${MOTION.fast}ms ease`,
          "&:focus-visible": { top: 8 },
        }}
      >
        {strings.skipToContent}
      </Button>
      <Header
        search={search}
        onSearchChange={setSearch}
        searchInputRef={searchInputRef}
        username={username}
        isAdmin={isAdmin}
        onLogin={() => setLoginOpen(true)}
        onLogout={logout}
        onOpenTransfers={() => setShowTransfers(true)}
        onOpenBranding={() => setBrandingOpen(true)}
        themeMode={themeMode}
        onThemeModeChange={onThemeModeChange}
        elevated={contentScrolled}
      />
      <Box
        component="main"
        sx={{
          display: "flex",
          flexDirection: "column",
          flexGrow: 1,
          minHeight: 0,
          overflow: "hidden",
        }}
      >
        <Main
          search={search}
          onSearchChange={setSearch}
          onNotify={onNotify}
          view={view}
          onViewChange={setView}
          sort={sort}
          onSortChange={setSort}
          route={route}
          navigate={navigate}
          onContentScroll={setContentScrolled}
          isAdmin={isAdmin}
          onLogin={() => setLoginOpen(true)}
        />
      </Box>
      <Snackbar
        key={currentSnack?.key}
        autoHideDuration={currentSnack?.duration ?? (currentSnack?.severity === "error" ? ERROR_SNACK_MS : DEFAULT_SNACK_MS)}
        open={snackOpen}
        onClose={() => setSnackOpen(false)}
        TransitionProps={{ onExited: () => setSnackQueue((queue) => queue.slice(1)) }}
        anchorOrigin={{ vertical: "top", horizontal: "center" }}
        sx={{ top: { xs: 64, sm: 72 } }}
      >
        <Alert
          severity={currentSnack?.severity ?? "info"}
          onClose={() => setSnackOpen(false)}
          action={
            currentSnack?.action ? (
              <Button
                color="inherit"
                size="small"
                onClick={() => {
                  const action = currentSnack.action;
                  setSnackOpen(false);
                  action?.onClick();
                }}
              >
                {currentSnack.action.label}
              </Button>
            ) : undefined
          }
          sx={{ width: "100%" }}
        >
          {currentSnack?.message}
        </Alert>
      </Snackbar>
      <TransferManager open={showTransfers} onClose={() => setShowTransfers(false)} />
      <LoginDialog open={loginOpen} onClose={() => setLoginOpen(false)} />
      <BrandingDialog
        open={brandingOpen}
        onClose={() => setBrandingOpen(false)}
        onNotify={onNotify}
      />
    </Stack>
  );
}

function ThemedApp() {
  const [themeMode, setThemeMode] = usePersistedState<ThemeModePreference>(
    "flaredrive.themeMode",
    "system"
  );
  const systemPrefersDark = useMediaQuery("(prefers-color-scheme: dark)", {
    noSsr: true,
  });
  const effectiveMode =
    themeMode === "system"
      ? systemPrefersDark
        ? "dark"
        : "light"
      : themeMode;
  const theme = useMemo(() => createAppTheme(effectiveMode), [effectiveMode]);

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <AppContent
        themeMode={themeMode}
        onThemeModeChange={setThemeMode}
      />
    </ThemeProvider>
  );
}

function App() {
  useEffect(() => {
    installThumbnailCacheCleanup();
    // 拉一次服务器上的品牌覆盖值（站点名 / Logo / 图标）；失败就保持构建期默认
    void loadBranding();
  }, []);
  return (
    <AuthProvider>
      <TransferQueueProvider>
        <ClipboardProvider>
          <ThemedApp />
        </ClipboardProvider>
      </TransferQueueProvider>
    </AuthProvider>
  );
}

export default App;
