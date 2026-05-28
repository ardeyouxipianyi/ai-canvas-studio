"use client";

export function formatAccountRefreshError(error?: string | null) {
  const raw = String(error || "").trim();
  const normalized = raw.toLowerCase();

  if (!normalized) {
    return "部分账号刷新失败，请稍后重试。";
  }

  if (
    normalized.includes("http 401") ||
    normalized.includes("unauthorized") ||
    normalized.includes("invalid access token") ||
    normalized.includes("invalidaccesstoken")
  ) {
    return "发现失效 Token：该账号无法通过上游验证，已标记为异常。";
  }

  if (normalized.includes("http 429") || normalized.includes("rate limit")) {
    return "上游请求过于频繁：部分账号暂时无法刷新，请稍后重试。";
  }

  if (normalized.includes("timeout") || normalized.includes("timed out")) {
    return "上游响应超时：部分账号暂时无法刷新，请稍后重试。";
  }

  if (normalized.includes("http 403") || normalized.includes("forbidden")) {
    return "上游拒绝访问：部分账号可能需要重新登录或检查账号状态。";
  }

  if (normalized.includes("network") || normalized.includes("connection")) {
    return "网络连接异常：部分账号暂时无法刷新。";
  }

  return "部分账号刷新失败，已保留失败计数。";
}
