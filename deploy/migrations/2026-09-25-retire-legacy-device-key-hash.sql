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
-- ⚠️ 重要：本迁移分两个阶段，不可一次性执行完！
--
--   阶段一（换发完成前）—— 只扩字段，不加约束
--     线上实测：2 台设备 key_hash 全部是 64 字符旧 sha256（legacy_rows=2）。
--     此时若加 CHECK (key_hash LIKE 'v2$%') 会**立刻违反现有数据**，
--     导致 ALTER 失败；更严重的是代码侧若同时关闭 ALLOW_LEGACY_KEY_HASH，
--     扫码枪会全线返回 2006（核销瘫痪）。
--     所以阶段一只做：字段扩容到 255 + 盘点。
--
--   阶段二（所有设备换发完成后）—— 加约束 + 关开关
--     后台逐台点「设备 → 换发密钥」，把密钥下发给扫码 App；
--     确认 legacy_rows = 0 后，再执行本文件下半部分的 CHECK 约束，
--     并把 .env 里的 ALLOW_LEGACY_KEY_HASH 改为 0（或不设，走生产默认）。
--
-- 为什么不能直接 UPDATE 改哈希？
--   哈希是单向的，无法从 sha256 值反推明文再算 scrypt。
--   唯一出路是**重新发放**设备密钥。
--
-- 执行方式
--   docker exec -i canteen-mysql sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" canteen_verify' \
--     < 2026-09-25-retire-legacy-device-key-hash.sql
--
-- 幂等：重复执行安全（先探测再 DDL）。
-- ════════════════════════════════════════════════════════════════════

-- ── 阶段一：盘点 + 扩容 ──────────────────────────────────────────

SELECT '=== 阶段一 · 迁移前盘点 ===' AS step;
SELECT COUNT(*) AS total_devices,
       SUM(key_hash LIKE 'v2$%') AS v2_rows,
       SUM(key_hash NOT LIKE 'v2$%') AS legacy_rows,
       MIN(LENGTH(key_hash)) AS min_len,
       MAX(LENGTH(key_hash)) AS max_len
FROM devices;

-- 字段宽度确保到 255（新哈希 131 字符的余量）；幂等
ALTER TABLE devices
  MODIFY COLUMN key_hash VARCHAR(255) NOT NULL;

SELECT '=== 阶段一 · 迁移后确认 ===' AS step;
SELECT COUNT(*) AS total_devices,
       SUM(key_hash LIKE 'v2$%') AS v2_rows,
       SUM(key_hash NOT LIKE 'v2$%') AS legacy_rows,
       MAX(LENGTH(key_hash)) AS max_len
FROM devices;

SHOW COLUMNS FROM devices LIKE 'key_hash';


-- ── 阶段二：仅当 legacy_rows = 0 时才执行以下内容 ────────────────
-- ⚠️ 若上面盘点显示 legacy_rows > 0，请**跳过**这一段，
--    先去后台把设备密钥逐个换发，确认清零后再回来执行。

-- SET @exist := (
--   SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
--   WHERE CONSTRAINT_SCHEMA = DATABASE()
--     AND TABLE_NAME = 'devices'
--     AND CONSTRAINT_NAME = 'chk_device_key_hash_v2'
-- );
-- SET @sql := IF(
--   @exist = 0,
--   "ALTER TABLE devices ADD CONSTRAINT chk_device_key_hash_v2 CHECK (key_hash LIKE 'v2$%')",
--   'SELECT ''约束 chk_device_key_hash_v2 已存在，跳过'' AS info'
-- );
-- PREPARE stmt FROM @sql;
-- EXECUTE stmt;
-- DEALLOCATE PREPARE stmt;
--
-- 执行完约束后，在 /opt/canteen/backend/.env 里设置：
--   ALLOW_LEGACY_KEY_HASH=0
-- 然后 pm2 restart canteen-api --update-env

