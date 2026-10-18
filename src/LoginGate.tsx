import React, { useState } from "react";
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Stack,
  TextField,
} from "@mui/material";
import BrandMark from "./BrandMark";
import { strings, translate } from "./app/strings";
import { authFetch, useAuth, utf8ToBase64 } from "./app/auth";

/**
 * 全屏登录门禁：管理员登录前，主站内容一概不渲染。
 *
 * 与 LoginDialog 的区别：LoginDialog 是会话中的口令重输入弹窗（可关闭），
 * 本组件是进入主界面的唯一入口（不可关闭、无跳过），关闭主站所有数据请求。
 */
function LoginGate() {
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
      }
    } catch {
      setError(translate("networkError"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Box
      sx={{
        minHeight: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        px: 2,
        py: 6,
        backgroundColor: "background.default",
      }}
    >
      <Box
        component="form"
        onSubmit={handleSubmit}
        aria-label={strings.loginTitle}
        sx={{
          width: "100%",
          maxWidth: 360,
          display: "grid",
          gap: 2,
          px: { xs: 2, sm: 4 },
          py: { xs: 4, sm: 5 },
          borderRadius: 2,
          backgroundColor: "background.paper",
          boxShadow: 3,
        }}
      >
        <Box
          sx={{
            display: "grid",
            justifyItems: "center",
            gap: 0.75,
            textAlign: "center",
          }}
        >
          <BrandMark size={52} orientation="column" />
        </Box>
        <TextField
          autoFocus
          fullWidth
          label={strings.username}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <TextField
          fullWidth
          label={strings.password}
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <Alert severity="error" variant="outlined">{error}</Alert>}
        <Button
          type="submit"
          variant="contained"
          size="large"
          disableElevation
          disabled={submitting || !username || !password}
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
      </Box>
    </Box>
  );
}

export default LoginGate;
