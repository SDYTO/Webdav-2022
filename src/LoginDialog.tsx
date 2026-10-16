import React, { useState } from "react";
import BrandMark from "./BrandMark";
import { strings, translate } from "./app/strings";
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  Stack,
  TextField,
} from "@mui/material";
import { authFetch, useAuth, utf8ToBase64 } from "./app/auth";

/**
 * 管理口令弹窗。只用于"写操作"，关闭后仍可继续浏览与下载。
 */
function LoginDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { login } = useAuth();
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!username || !password) return;
    setSubmitting(true);
    setError(null);

    try {
      const response = await authFetch("/api/auth", {
        headers: {
          Authorization: `Basic ${utf8ToBase64(`${username}:${password}`)}`,
        },
      });
      if (response.status === 503) {
        setError(strings.adminPasswordNotConfigured);
      } else if (!response.ok) {
        setError(translate("wrongCredentials"));
      } else {
        login({ username, password });
        setPassword("");
        onClose();
      }
    } catch {
      setError(translate("networkError"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullWidth
      maxWidth="xs"
      aria-label={strings.loginTitle}
    >
      <form onSubmit={handleSubmit}>
        <DialogContent sx={{ pt: { xs: 4, sm: 5 } }}>
          <Box
            sx={{
              display: "grid",
              justifyItems: "center",
              gap: 0.75,
              mb: 3,
              textAlign: "center",
            }}
          >
            <BrandMark size={46} orientation="column" />
            <DialogContentText sx={{ maxWidth: 320 }}>
              {strings.adminOnlyHint}
            </DialogContentText>
          </Box>
          <TextField
            autoFocus
            fullWidth
            label={strings.username}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            margin="dense"
          />
          <TextField
            fullWidth
            label={strings.password}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            margin="dense"
          />
          {error && (
            <Alert severity="error" variant="outlined" sx={{ marginTop: 2 }}>
              {error}
            </Alert>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: { xs: 3, sm: 4 }, pt: 0 }}>
          <Button onClick={onClose}>{strings.close}</Button>
          <Button
            type="submit"
            variant="contained"
            size="large"
            disableElevation
            disabled={submitting}
          >
            {submitting ? (
              <Stack direction="row" spacing={1} alignItems="center">
                <CircularProgress size={16} color="inherit" />
                <span>{strings.loading}</span>
              </Stack>
            ) : (
              strings.login
            )}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

export default LoginDialog;
