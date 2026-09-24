-- ============================================================
-- 企业团餐核销系统 · 生产/测试环境种子数据（MySQL 8）
--
-- 为什么需要这个文件：
--   ensure-database.ts 的种子数据只在 LOCAL_MODE=1（SQLite）时灌入，
--   走 MySQL 时数据库是空的 —— 一个账号都登不进去。
--   这个脚本负责把「能直接演示」的那套数据灌进 MySQL。
--
-- 幂等设计：全部用 INSERT ... ON DUPLICATE KEY UPDATE 或先查后插，
--   重复执行不会产生重复数据，也不会覆盖已改过的密码。
--
-- 用法（在服务器上）：
--   mysql -h127.0.0.1 -P3307 -uroot -pXXX canteen_verify < seed.sql
-- ============================================================
SET NAMES utf8mb4;

-- ------------------------------------------------------------
-- 套餐
-- ------------------------------------------------------------
INSERT INTO `plans` (`name`, `quota`, `price`, `valid_days`, `status`)
SELECT '基础套餐 100 次', 100, 1980.00, 365, 1
WHERE NOT EXISTS (SELECT 1 FROM `plans` WHERE `name` = '基础套餐 100 次');

INSERT INTO `plans` (`name`, `quota`, `price`, `valid_days`, `status`)
SELECT '标准套餐 500 次', 500, 8800.00, 365, 1
WHERE NOT EXISTS (SELECT 1 FROM `plans` WHERE `name` = '标准套餐 500 次');

-- ------------------------------------------------------------
-- 公司
-- ------------------------------------------------------------
INSERT INTO `companies`
  (`name`, `contact_name`, `contact_phone`, `plan_id`, `total_quota`, `remain_quota`, `status`)
SELECT '示例科技有限公司', '张经理', '13800000001',
       (SELECT id FROM `plans` WHERE `name` = '基础套餐 100 次' LIMIT 1), 100, 100, 1
WHERE NOT EXISTS (SELECT 1 FROM `companies` WHERE `name` = '示例科技有限公司');

INSERT INTO `companies`
  (`name`, `contact_name`, `contact_phone`, `plan_id`, `total_quota`, `remain_quota`, `status`)
SELECT '另一家制造企业', '李主管', '13800000002',
       (SELECT id FROM `plans` WHERE `name` = '标准套餐 500 次' LIMIT 1), 500, 500, 1
WHERE NOT EXISTS (SELECT 1 FROM `companies` WHERE `name` = '另一家制造企业');

-- ------------------------------------------------------------
-- 门店（总部食堂绑 A 公司，二厂食堂绑 B 公司）
--   注意 stores 表只有 (name, company_id, status)，没有地址/电话字段
-- ------------------------------------------------------------
INSERT INTO `stores` (`company_id`, `name`, `status`)
SELECT c.id, '总部食堂', 1
FROM `companies` c WHERE c.name = '示例科技有限公司'
  AND NOT EXISTS (SELECT 1 FROM `stores` s WHERE s.name = '总部食堂' AND s.company_id = c.id);

INSERT INTO `stores` (`company_id`, `name`, `status`)
SELECT c.id, '二厂食堂', 1
FROM `companies` c WHERE c.name = '另一家制造企业'
  AND NOT EXISTS (SELECT 1 FROM `stores` s WHERE s.name = '二厂食堂' AND s.company_id = c.id);

-- ------------------------------------------------------------
-- 管理员
--   密码哈希为 bcrypt('admin123456') / bcrypt('company123456')（cost 10），
--   与 ensure-database.ts 的 bcrypt.hash(..., 10) 同参数，已实测比对通过。
--   ⚠️ 上线前务必改掉这几个默认密码。
-- ------------------------------------------------------------
INSERT INTO `admins` (`username`, `password_hash`, `role`, `company_id`, `status`)
SELECT 'admin',
       '$2a$10$Z/nqB0RcUoEp/4lfZqPIr.V3u0gGHjd8hT//joErwoK4NHucYE1La',
       'super', NULL, 1
WHERE NOT EXISTS (SELECT 1 FROM `admins` WHERE `username` = 'admin');

INSERT INTO `admins` (`username`, `password_hash`, `role`, `company_id`, `status`)
SELECT 'company_a',
       '$2a$10$260LaanPhQRwWq0.RNfkcuEFyncYBTbrSu/MpiQz7FJW8vjwMmwZS',
       'company',
       (SELECT id FROM `companies` WHERE `name` = '示例科技有限公司' LIMIT 1), 1
WHERE NOT EXISTS (SELECT 1 FROM `admins` WHERE `username` = 'company_a');

INSERT INTO `admins` (`username`, `password_hash`, `role`, `company_id`, `status`)
SELECT 'company_b',
       '$2a$10$260LaanPhQRwWq0.RNfkcuEFyncYBTbrSu/MpiQz7FJW8vjwMmwZS',
       'company',
       (SELECT id FROM `companies` WHERE `name` = '另一家制造企业' LIMIT 1), 1
WHERE NOT EXISTS (SELECT 1 FROM `admins` WHERE `username` = 'company_b');

-- ------------------------------------------------------------
-- 核销时段规则（A 公司：早/午/晚三段）
-- ------------------------------------------------------------
INSERT INTO `verification_rules`
  (`company_id`, `name`, `start_time`, `end_time`, `per_employee_limit`, `status`)
SELECT c.id, '早餐', '07:00', '09:00', 1, 1
FROM `companies` c WHERE c.name = '示例科技有限公司'
  AND NOT EXISTS (SELECT 1 FROM `verification_rules` r WHERE r.company_id = c.id AND r.name = '早餐');

INSERT INTO `verification_rules`
  (`company_id`, `name`, `start_time`, `end_time`, `per_employee_limit`, `status`)
SELECT c.id, '午餐', '11:30', '13:30', 1, 1
FROM `companies` c WHERE c.name = '示例科技有限公司'
  AND NOT EXISTS (SELECT 1 FROM `verification_rules` r WHERE r.company_id = c.id AND r.name = '午餐');

INSERT INTO `verification_rules`
  (`company_id`, `name`, `start_time`, `end_time`, `per_employee_limit`, `status`)
SELECT c.id, '晚餐', '17:30', '19:30', 1, 1
FROM `companies` c WHERE c.name = '示例科技有限公司'
  AND NOT EXISTS (SELECT 1 FROM `verification_rules` r WHERE r.company_id = c.id AND r.name = '晚餐');

-- ------------------------------------------------------------
-- 员工
-- ------------------------------------------------------------
INSERT INTO `employees` (`company_id`, `name`, `phone`, `employee_no`, `status`)
SELECT c.id, '张三', '13900000001', 'A0001', 1
FROM `companies` c WHERE c.name = '示例科技有限公司'
  AND NOT EXISTS (SELECT 1 FROM `employees` e WHERE e.employee_no = 'A0001');

INSERT INTO `employees` (`company_id`, `name`, `phone`, `employee_no`, `status`)
SELECT c.id, '李四', '13900000002', 'A0002', 1
FROM `companies` c WHERE c.name = '示例科技有限公司'
  AND NOT EXISTS (SELECT 1 FROM `employees` e WHERE e.employee_no = 'A0002');

INSERT INTO `employees` (`company_id`, `name`, `phone`, `employee_no`, `status`)
SELECT c.id, '王五', '13900000003', 'B0001', 1
FROM `companies` c WHERE c.name = '另一家制造企业'
  AND NOT EXISTS (SELECT 1 FROM `employees` e WHERE e.employee_no = 'B0001');

-- ------------------------------------------------------------
-- 设备：一机一密钥，只存 sha256
--   device-key-demo-0001 → 绑总部食堂
--   device-key-demo-0002 → 不绑店
--   sha256 值由 Node 侧算出，与 VerifyService.hashDeviceKey 一致
-- ------------------------------------------------------------
INSERT INTO `devices` (`name`, `key_hash`, `key_prefix`, `store_id`, `company_id`, `status`)
SELECT '总部食堂扫码枪',
       SHA2('device-key-demo-0001', 256),
       'device-k',
       (SELECT id FROM `stores` WHERE `name` = '总部食堂' LIMIT 1),
       (SELECT id FROM `companies` WHERE `name` = '示例科技有限公司' LIMIT 1),
       1
WHERE NOT EXISTS (SELECT 1 FROM `devices` WHERE `key_hash` = SHA2('device-key-demo-0001', 256));

INSERT INTO `devices` (`name`, `key_hash`, `key_prefix`, `store_id`, `company_id`, `status`)
SELECT '备用扫码枪', SHA2('device-key-demo-0002', 256), 'device-k', NULL, NULL, 1
WHERE NOT EXISTS (SELECT 1 FROM `devices` WHERE `key_hash` = SHA2('device-key-demo-0002', 256));

-- ------------------------------------------------------------
-- 汇总确认
-- ------------------------------------------------------------
SELECT '套餐' AS 表, COUNT(*) AS 行数 FROM `plans`
UNION ALL SELECT '公司', COUNT(*) FROM `companies`
UNION ALL SELECT '门店', COUNT(*) FROM `stores`
UNION ALL SELECT '管理员', COUNT(*) FROM `admins`
UNION ALL SELECT '员工', COUNT(*) FROM `employees`
UNION ALL SELECT '时段规则', COUNT(*) FROM `verification_rules`
UNION ALL SELECT '设备', COUNT(*) FROM `devices`;
