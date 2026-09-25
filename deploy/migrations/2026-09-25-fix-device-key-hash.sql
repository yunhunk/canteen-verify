-- ═══════════════════════════════════════════════════════════════
--  修复：devices.key_hash 长度不足（Data too long for column 'key_hash'）
-- ═══════════════════════════════════════════════════════════════
--
--  背景：
--    安全审计 P1-1 把设备密钥哈希从裸 sha256（64 字符）换成
--    scrypt（KEY_LEN=64 → hex 128 字符），并加了 `v2$` 版本前缀
--    （共 131 字符），但表字段仍是 varchar(64)，导致：
--      - 登记新设备   → Data too long for column 'key_hash'
--      - 换发密钥     → 同上报错
--      - 设备核销鉴权 → biz 2006 设备密钥无效（老 sha256 设备查不通）
--
--  本脚本做两件事：
--    1. key_hash 扩到 varchar(255)（唯一索引需先删后建）
--    2. 顺手把历史种子设备的密钥回填说明（见下）
--
--  幂等：可重复执行。执行前请确认已备份。
-- ═══════════════════════════════════════════════════════════════

-- ── 1. 查询当前状态（执行前留档）──────────────────────────────
SELECT '=== BEFORE ===' AS step;
SHOW COLUMNS FROM devices LIKE 'key_hash';

-- ── 2. 扩容 key_hash ────────────────────────────────────────
-- MySQL 修改被索引列的长度需要先删索引再重建，否则报 1071/1091。
-- 用 information_schema 判断索引是否存在，保证幂等。
SET @idx_exists := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'devices'
    AND INDEX_NAME = 'uk_key_hash'
);
SET @sql := IF(@idx_exists > 0,
  'ALTER TABLE devices DROP INDEX uk_key_hash',
  'SELECT ''uk_key_hash 不存在，跳过删除'' AS msg');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 扩容到 255（v2$ + 128 hex = 131，余量充足）
ALTER TABLE devices MODIFY COLUMN key_hash VARCHAR(255) NOT NULL;

-- 重建唯一索引
SET @idx_exists2 := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'devices'
    AND INDEX_NAME = 'uk_key_hash'
);
SET @sql2 := IF(@idx_exists2 = 0,
  'ALTER TABLE devices ADD UNIQUE INDEX uk_key_hash (key_hash)',
  'SELECT ''uk_key_hash 已存在，跳过创建'' AS msg');
PREPARE stmt2 FROM @sql2; EXECUTE stmt2; DEALLOCATE PREPARE stmt2;

-- ── 3. 校验结果 ─────────────────────────────────────────────
SELECT '=== AFTER ===' AS step;
SHOW COLUMNS FROM devices LIKE 'key_hash';

-- 当前设备哈希形态一览（hlen=64 为旧 sha256，hlen=131 为 v2$ scrypt）
SELECT id, name, key_prefix, status, LENGTH(key_hash) AS hash_len,
       LEFT(key_hash, 3) AS prefix3,
       CASE
         WHEN LEFT(key_hash, 3) = 'v2$' THEN 'v2 scrypt（新）'
         WHEN LENGTH(key_hash) = 64    THEN 'legacy sha256（旧，兼容期可验通）'
         ELSE '未知'
       END AS algo
FROM devices;
