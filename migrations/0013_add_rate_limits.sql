-- 通用速率限制计数表（匿名点赞 / 浏览量去重 / 其他限流场景共用）
-- 与 auth_login_attempts 结构保持一致，但独立成表，避免语义混淆

CREATE TABLE IF NOT EXISTS rate_limits (
  attempt_key TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0,
  window_started_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_window ON rate_limits (window_started_at);
