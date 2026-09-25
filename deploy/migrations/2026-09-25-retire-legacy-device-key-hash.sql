-- ════════════════════════════════════════════════════════════════════
-- 迁移：淘汰设备密钥的旧 sha256 哈希形态（MonkeyScan 漏洞 fb0a0）
-- ════════════════════════════════════════════════════════════════════
--
-- 背景
--   早期实现用裸 sha256 存 key_hash（64 字符 hex），属快速哈希，
--   库一旦泄露可被离线高速爆破。新实现改为 scrypt，产物带 `v2$`
--   前缀（131 字符）。为不破坏已登记设备，代码在过渡期内**同时**
--   接受两种形态（candidateHashesAsync 双算法回溯）。
--
-- 本次要做的事
--   1. 确认没有残留的旧 sha256 行（无 v2$ 前缀的 key_hash）；
--   2. 加一个 CHECK 约束，从数据库层面**禁止**再写入旧形态；
--   3. （可选）如仍有旧行，走"换发密钥"流程：后台给设备重新生成
--      v2$ 密钥并下发给扫码 App，旧行删除。
--
-- ⚠️ 为什么不能直接 UPDATE 改哈希？
--   哈希是单向的，无法从 sha256 值反推明文再算 scrypt。
--   唯一出路是**重新发放**设备密钥（后台"换发密钥"按钮），
--   或在 App 端保存有明文时重绑一次。因此本脚本只做校验与约束，
--   不做数据重写。
--
-- 执行方式
--   docker exec -i canteen-mysql mysql -uroot -p"$MYSQL_ROOT_PASSWORD" \
--     canteen_verify < 2026-09-25-retire-legacy-device-key-hash.sql
--
-- 幂等：重复执行安全（先探测再 DDL）。
-- ════════════════════════════════════════════════════════════════════

-- ── 第 1 步：盘点旧形态行数。期望 0；非 0 请先换发密钥再继续 ──
SELECT COUNT(*) AS legacy_sha256_rows
FROM devices
WHERE key_hash IS NOT NULL
  AND key_hash <> ''
  AND key_hash NOT LIKE 'v2$%';

-- ── 第 2 步：把字段宽度确保到 255（新哈希 131 字符的余量）──
-- 幂等：varchar(255) 再改一次也无害。
ALTER TABLE devices
  MODIFY COLUMN key_hash VARCHAR(255) NOT NULL;

-- ── 第 3 步：加约束，禁止未来再写入旧形态 ──
-- 兼容 MySQL 8：先探测约束是否存在，避免重复添加报错。
SET @exist := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND TABLE_NAME = 'devices'
    AND CONSTRAINT_NAME = 'chk_device_key_hash_v2'
);
SET @sql := IF(
  @exist = 0,
  "ALTER TABLE devices ADD CONSTRAINT chk_device_key_hash_v2 CHECK (key_hash LIKE 'v2$%')",
  'SELECT ''约束 chk_device_key_hash_v2 已存在，跳过'' AS info'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ── 第 4 步：收尾确认 ──
SELECT COUNT(*) AS total_devices,
       SUM(key_hash LIKE 'v2$%') AS v2_rows,
       SUM(key_hash NOT LIKE 'v2$%') AS non_v2_rows
FROM devices;

-- 约束加完后，即可在生产 .env 里显式设置：
--   ALLOW_LEGACY_KEY_HASH=0
-- 彻底关闭代码侧的 sha256 回溯（生产默认已关闭，此项是显式加固）。
