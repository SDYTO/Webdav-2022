import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  Typography,
} from "@mui/material";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";

import { NotifyFn } from "./app/notify";
import { strings, translate } from "./app/strings";

/**
 * WebDAV 连接说明。
 * 本项目的 WebDAV 是"读取免密、写入需口令"：地址直接可用，
 * 只有 PUT/DELETE/MKCOL/MOVE 等方法才要求 admin + 管理口令。
 */
function WebDavPanel({
  open,
  onClose,
  onNotify,
}: {
  open: boolean;
  onClose: () => void;
  onNotify: NotifyFn;
}) {
  // 挂载地址统一用带结尾斜杠的集合地址（两种写法服务端都接受）
  const webdavUrl = `${window.location.origin}/webdav/`;

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      onNotify(translate("copiedFormat", { label }), "success");
    } catch {
      onNotify(translate("copyFailed2"), "error");
    }
  };

  const guide = [
    `${translate("address")}：${webdavUrl}`,
    translate("webdavFreeRead"),
    translate("webdavWriteNote"),
    translate("uploadLimitNote"),
    translate("finderHowTo"),
  ].join("\n");

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{strings.webdavTitle}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ marginTop: 1 }}>
          <Box>
            <Typography variant="caption" color="text.secondary">
              {strings.address}
            </Typography>
            <Typography sx={{ wordBreak: "break-all" }}>{webdavUrl}</Typography>
            <Button
              size="small"
              startIcon={<ContentCopyIcon />}
              onClick={() => copy(webdavUrl, strings.address)}
            >
              {strings.copyAddress}
            </Button>
          </Box>
          <Box>
            <Typography variant="caption" color="text.secondary">
              {strings.webdavReadOpen}
            </Typography>
            <Typography variant="body2">{strings.webdavFreeRead}</Typography>
          </Box>
          <Box>
            <Typography variant="caption" color="text.secondary">
              {strings.webdavWriteProtected}
            </Typography>
            <Typography variant="body2">{strings.webdavWriteNote}</Typography>
          </Box>
          <Box
            sx={{
              p: 1.5,
              borderRadius: 2,
              backgroundColor: "background.default",
              border: "1px solid",
              borderColor: "divider",
            }}
          >
            <Typography
              variant="body2"
              sx={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}
            >
              {guide}
            </Typography>
            <Button
              size="small"
              startIcon={<ContentCopyIcon />}
              onClick={() => copy(guide, strings.fullGuide)}
              sx={{ mt: 1 }}
            >
              {strings.copyWebDavGuide}
            </Button>
          </Box>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{strings.close}</Button>
      </DialogActions>
    </Dialog>
  );
}

export default WebDavPanel;
