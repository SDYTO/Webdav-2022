import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  Divider,
  FormControlLabel,
  Stack,
  Switch,
  TextField,
  Typography,
} from "@mui/material";
import {
  DeleteOutline as ClearIcon,
  ImageOutlined as ImageIcon,
  RestartAlt as ResetIcon,
} from "@mui/icons-material";

import {
  ASSET_KINDS,
  ASSET_URL_FIELD,
  resetBranding,
  saveBranding,
  useBranding,
  type AssetKind,
} from "./app/branding";
import { strings, translate } from "./app/strings";

/** 每种素材在界面上的说明，文案与 branding/README.md 的建议保持一致。 */
const ASSET_META: Record<AssetKind, { label: string; hint: string; previewHeight: number }> = {
  logo: { label: "站点 Logo", hint: "建议 SVG 或 PNG，高约 48–96 px，横向或方形均可", previewHeight: 34 },
  icon: { label: "站点图标", hint: "浏览器标签页图标，建议方形 PNG 512×512 或 SVG", previewHeight: 34 },
  appleTouchIcon: {
    label: "主屏图标",
    hint: "iOS/Android 添加到主屏时使用，建议方形 PNG 180×180 及以上",
    previewHeight: 34,
  },
};

type AssetFiles = Partial<Record<AssetKind, File>>;
type AssetFlags = Partial<Record<AssetKind, boolean>>;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 品牌设置弹窗（仅管理员可见入口）。
 *
 * 保存后由 app/branding 的 store 广播，顶栏 / 登录弹窗 / 浏览器图标与标题立即更新；
 * WebDAV 浏览页是服务端渲染的，下次打开自然读到的也是新品牌。
 */
function BrandingDialog({
  open,
  onClose,
  onNotify,
}: {
  open: boolean;
  onClose: () => void;
  onNotify: (message: string, severity?: "success" | "error" | "info") => void;
}) {
  const branding = useBranding();

  const [siteName, setSiteName] = useState(branding.siteName);
  const [shortName, setShortName] = useState(branding.shortName);
  const [description, setDescription] = useState(branding.description);
  const [showNameBesideLogo, setShowNameBesideLogo] = useState(branding.showNameBesideLogo);
  const [files, setFiles] = useState<AssetFiles>({});
  const [removed, setRemoved] = useState<AssetFlags>({});
  const [previews, setPreviews] = useState<Partial<Record<AssetKind, string>>>({});
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 每次打开都用服务端的当前值重置表单，避免上次编辑的半成品残留
  useEffect(() => {
    if (!open) return;
    setSiteName(branding.siteName);
    setShortName(branding.shortName);
    setDescription(branding.description);
    setShowNameBesideLogo(branding.showNameBesideLogo);
    setFiles({});
    setRemoved({});
    setError(null);
    // 只在打开的那一刻同步，编辑过程中不跟着 store 变
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 新选的本地文件用 object URL 预览，离开时释放，避免内存泄漏
  useEffect(() => {
    const created: Partial<Record<AssetKind, string>> = {};
    for (const kind of ASSET_KINDS) {
      const file = files[kind];
      if (file) created[kind] = URL.createObjectURL(file);
    }
    setPreviews(created);
    return () => {
      Object.values(created).forEach((url) => {
        if (url) URL.revokeObjectURL(url);
      });
    };
  }, [files]);

  const currentUrl = useMemo(
    () => (kind: AssetKind) => {
      const value = branding[ASSET_URL_FIELD[kind]];
      return typeof value === "string" ? value : null;
    },
    [branding]
  );

  const pickFile = (kind: AssetKind, file: File | null) => {
    if (!file) return;
    setFiles((previous) => ({ ...previous, [kind]: file }));
    setRemoved((previous) => ({ ...previous, [kind]: false }));
    setError(null);
  };

  const clearAsset = (kind: AssetKind) => {
    setFiles((previous) => {
      const next = { ...previous };
      delete next[kind];
      return next;
    });
    setRemoved((previous) => ({ ...previous, [kind]: true }));
  };

  const buildForm = () => {
    const form = new FormData();
    form.set("siteName", siteName);
    form.set("shortName", shortName);
    form.set("description", description);
    form.set("showNameBesideLogo", showNameBesideLogo ? "true" : "false");
    for (const kind of ASSET_KINDS) {
      const file = files[kind];
      if (file) {
        form.set(kind, file, file.name || kind);
        continue;
      }
      if (removed[kind]) form.set(`remove__${kind}`, "1");
    }
    return form;
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const result = await saveBranding(buildForm());
      onClose();
      onNotify(
        result.notes.length
          ? `${strings.brandingSaved}：${result.notes.join("；")}`
          : strings.brandingSaved,
        "success"
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    if (!window.confirm(strings.brandingResetConfirm)) return;
    setResetting(true);
    setError(null);
    try {
      await resetBranding();
      setFiles({});
      setRemoved({});
      onClose();
      onNotify(strings.brandingReset, "success");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setResetting(false);
    }
  };

  const busy = saving || resetting;

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogContent sx={{ pt: 3 }}>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
          <Typography variant="h6" component="h2" sx={{ fontWeight: 700 }}>
            {strings.brandingTitle}
          </Typography>
          {branding.customized && (
            <Chip size="small" color="primary" variant="outlined" label={strings.brandingCustomized} />
          )}
        </Stack>
        <DialogContentText sx={{ mb: 2 }}>{strings.brandingHint}</DialogContentText>

        <TextField
          fullWidth
          margin="dense"
          label={strings.brandingSiteName}
          value={siteName}
          onChange={(event) => setSiteName(event.target.value)}
          inputProps={{ maxLength: 60 }}
          helperText={strings.brandingSiteNameHint}
        />
        <TextField
          fullWidth
          margin="dense"
          label={strings.brandingShortName}
          value={shortName}
          onChange={(event) => setShortName(event.target.value)}
          inputProps={{ maxLength: 24 }}
          helperText={strings.brandingShortNameHint}
        />
        <TextField
          fullWidth
          margin="dense"
          label={strings.brandingDescription}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          inputProps={{ maxLength: 200 }}
          multiline
          minRows={2}
        />

        <Divider sx={{ my: 2 }} />

        {ASSET_KINDS.map((kind) => {
          const meta = ASSET_META[kind];
          const previewUrl = previews[kind] ?? (removed[kind] ? null : currentUrl(kind));
          const file = files[kind];
          return (
            <Box key={kind} sx={{ mb: 2 }}>
              <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                {meta.label}
              </Typography>
              <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mt: 0.75 }}>
                <Box
                  sx={{
                    width: 56,
                    height: 56,
                    flexShrink: 0,
                    borderRadius: 1.5,
                    border: "1px dashed",
                    borderColor: "divider",
                    backgroundColor: "background.default",
                    display: "grid",
                    placeItems: "center",
                    overflow: "hidden",
                  }}
                >
                  {previewUrl ? (
                    <Box
                      component="img"
                      src={previewUrl}
                      alt=""
                      sx={{
                        maxWidth: "88%",
                        maxHeight: "88%",
                        objectFit: "contain",
                        display: "block",
                      }}
                    />
                  ) : (
                    <ImageIcon fontSize="small" sx={{ color: "text.disabled" }} />
                  )}
                </Box>
                <Box sx={{ minWidth: 0, flexGrow: 1 }}>
                  <Stack direction="row" spacing={1} alignItems="center" useFlexGap flexWrap="wrap">
                    <Button
                      component="label"
                      size="small"
                      variant="outlined"
                      disabled={busy}
                      startIcon={<ImageIcon />}
                    >
                      {strings.brandingChooseImage}
                      <input
                        type="file"
                        hidden
                        accept="image/svg+xml,image/png,image/jpeg,image/gif,image/webp,image/x-icon"
                        onChange={(event) => {
                          pickFile(kind, event.target.files?.[0] ?? null);
                          // 允许连续选同一个文件时也触发 change
                          event.target.value = "";
                        }}
                      />
                    </Button>
                    {previewUrl && (
                      <Button
                        size="small"
                        color="inherit"
                        disabled={busy}
                        startIcon={<ClearIcon />}
                        onClick={() => clearAsset(kind)}
                      >
                        {strings.brandingClearImage}
                      </Button>
                    )}
                  </Stack>
                  <Typography variant="caption" sx={{ color: "text.secondary", display: "block", mt: 0.5 }}>
                    {file ? `${file.name} · ${formatBytes(file.size)}` : meta.hint}
                  </Typography>
                </Box>
              </Stack>
            </Box>
          );
        })}

        <FormControlLabel
          control={
            <Switch
              checked={showNameBesideLogo}
              onChange={(event) => setShowNameBesideLogo(event.target.checked)}
              disabled={busy}
            />
          }
          label={strings.brandingShowName}
        />

        {error && (
          <Alert severity="error" variant="outlined" sx={{ mt: 2 }}>
            {error}
          </Alert>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2.5, pt: 0, flexWrap: "wrap", gap: 1 }}>
        <Button
          color="inherit"
          disabled={busy || !branding.customized}
          startIcon={<ResetIcon />}
          onClick={handleReset}
          sx={{ mr: "auto" }}
        >
          {strings.brandingResetAction}
        </Button>
        <Button onClick={onClose} disabled={busy}>
          {strings.cancel}
        </Button>
        <Button
          variant="contained"
          disableElevation
          disabled={busy}
          onClick={handleSave}
          startIcon={saving ? <CircularProgress size={16} color="inherit" /> : undefined}
        >
          {saving ? translate("saving") : strings.save}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default BrandingDialog;
