import type { Env } from './types';

/**
 * 通用的 D1 速率限制工具。
 *
 * 设计要点：
 * - 计数落在 D1 的 rate_limits 表里（见 migrations/0013_add_rate_limits.sql）
 * - key 里只放哈希后的 IP / 标识，不落明文
 * - 任何异常都 fail-open（限流器自身故障时不拦正常访问）
 */

export interface RateLimitRule {
  key: string;
  limit: number;
  windowSeconds: number;
}

const BUMP_SQL = `
  INSERT INTO rate_limits (attempt_key, attempts, window_started_at)
  VALUES (?, 1, ?)
  ON CONFLICT(attempt_key) DO UPDATE SET
    attempts = CASE
      WHEN rate_limits.window_started_at <= ? THEN 1
      ELSE rate_limits.attempts + 1
    END,
    window_started_at = CASE
      WHEN rate_limits.window_started_at <= ? THEN ?
      ELSE rate_limits.window_started_at
    END
`;

const READ_SQL = 'SELECT attempts, window_started_at FROM rate_limits WHERE attempt_key = ?';

export async function hashRateLimitKey(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function getClientIp(c: any): string {
  return String(
    c.req.header('cf-connecting-ip') ||
    c.req.header('x-forwarded-for') ||
    c.req.header('x-real-ip') ||
    ''
  )
    .split(',')[0]
    .trim();
}

async function cleanup(env: Env, now: number): Promise<void> {
  try {
    await env.DB.prepare('DELETE FROM rate_limits WHERE window_started_at <= ?')
      .bind(now - 86400)
      .run();
  } catch {
    // 清理失败不影响主流程
  }
}

/**
 * 消耗一次配额。返回 true 表示**已超限**，调用方应拒绝或跳过该动作。
 * 注意：会真实递增计数，只应在“动作即将执行”时调用。
 */
export async function consumeRateLimit(env: Env, rules: RateLimitRule[]): Promise<boolean> {
  if (!rules.length) {
    return false;
  }

  const now = Math.floor(Date.now() / 1000);

  try {
    await env.DB.batch(
      rules.map((rule) => {
        const resetBefore = now - rule.windowSeconds;
        return env.DB.prepare(BUMP_SQL).bind(rule.key, now, resetBefore, resetBefore, now);
      })
    );

    const reads = await env.DB.batch(
      rules.map((rule) => env.DB.prepare(READ_SQL).bind(rule.key))
    );

    const limited = rules.some((rule, index) => {
      const row = reads[index]?.results?.[0] as
        | { attempts?: number; window_started_at?: number }
        | undefined;

      if (!row) {
        return false;
      }

      // 窗口已过期，视作未超限
      if (Number(row.window_started_at) <= now - rule.windowSeconds) {
        return false;
      }

      return Number(row.attempts || 0) > rule.limit;
    });

    // 顺手清掉 24 小时前的陈旧计数（低频触发，避免额外的写入开销）
    if (Math.random() < 0.02) {
      await cleanup(env, now);
    }

    return limited;
  } catch (error) {
    console.error('consumeRateLimit failed:', error);
    // fail-open：限流器故障不应影响站点可用性
    return false;
  }
}
