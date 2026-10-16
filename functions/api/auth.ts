import {
  DriveEnv,
  adminUser,
  jsonResponse,
  textResponse,
  timingSafeEqual,
  utf8ToBase64,
} from "./_core";

/**
 * GET /api/auth —— 校验「写操作口令」是否有效，供前端登录态判断。
 *
 * 只回一个布尔结果，不返回任何文件数据，也不回 WWW-Authenticate
 * （否则浏览器会弹原生 Basic 登录框，与前端自己的口令弹窗打架）。
 */
export const onRequestGet: PagesFunction<DriveEnv> = async (context) => {
  const { request, env } = context;
  const password = env.ADMIN_PASSWORD || "";
  if (!password) {
    return textResponse(
      "写操作口令未配置（请在部署环境变量中设置 ADMIN_PASSWORD）",
      503
    );
  }
  const expected = `Basic ${utf8ToBase64(`${adminUser(env)}:${password}`)}`;
  const authorization = request.headers.get("Authorization") || "";
  const ok = timingSafeEqual(authorization, expected);
  return jsonResponse({ ok, user: ok ? adminUser(env) : null }, ok ? 200 : 401);
};
