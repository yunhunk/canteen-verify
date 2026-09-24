-- ============================================================
-- 企业团餐核销系统 · 建表脚本（MySQL 8）
-- 与 TypeORM 实体严格对齐，由 npm run check:schema 校验漂移
-- ============================================================
SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- 公司（租户）
CREATE TABLE IF NOT EXISTS `companies` (
  `id` BIGINT NOT NULL AUTO_INCREMENT COMMENT '主键',
  `name` VARCHAR(100) NOT NULL COMMENT '公司名称',
  `contact_name` VARCHAR(50) NULL COMMENT '联系人',
  `contact_phone` VARCHAR(20) NULL COMMENT '联系电话',
  `plan_id` BIGINT NULL COMMENT '当前套餐',
  `total_quota` INT NOT NULL DEFAULT 0 COMMENT '套餐总次数',
  `remain_quota` INT NOT NULL DEFAULT 0 COMMENT '剩余次数（冗余）',
  `meal_standard` DECIMAL(10,2) NULL COMMENT '餐标（元），NULL=未设置；仅展示与语音播报，不参与扣减',
  `status` TINYINT NOT NULL DEFAULT 1 COMMENT '1启用 / 0停用',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_company_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='公司（租户）';

-- 套餐
CREATE TABLE IF NOT EXISTS `plans` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(100) NOT NULL COMMENT '套餐名称',
  `quota` INT NOT NULL DEFAULT 0 COMMENT '包含次数',
  `price` DECIMAL(10,2) NOT NULL DEFAULT 0.00 COMMENT '价格',
  `valid_days` INT NOT NULL DEFAULT 0 COMMENT '有效天数，0=永久',
  `status` TINYINT NOT NULL DEFAULT 1,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='套餐';

-- 员工（一人一号，停用为逻辑删除）
CREATE TABLE IF NOT EXISTS `employees` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `company_id` BIGINT NOT NULL COMMENT '所属公司（租户隔离）',
  `name` VARCHAR(50) NOT NULL COMMENT '姓名',
  `phone` VARCHAR(20) NOT NULL COMMENT '手机号（唯一）',
  `openid` VARCHAR(64) NULL COMMENT '微信 openid',
  `employee_no` VARCHAR(50) NULL COMMENT '工号',
  `status` TINYINT NOT NULL DEFAULT 1 COMMENT '1正常 / 0停用',
  `token_version` INT NOT NULL DEFAULT 1 COMMENT '会话版本；解绑微信时+1，令旧 token 立即失效',
  `quota_total` INT NULL COMMENT '公司分配的核销总次数；NULL=不限制，0=不允许核销',
  `quota_used` INT NOT NULL DEFAULT 0 COMMENT '已核销次数（只增不减，剩余=total-used）',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_phone` (`phone`),
  UNIQUE KEY `uk_openid` (`openid`),
  KEY `idx_company` (`company_id`),
  KEY `idx_company_status` (`company_id`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='员工';

-- 核销/消费记录
CREATE TABLE IF NOT EXISTS `consumptions` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `company_id` BIGINT NOT NULL COMMENT '冗余租户 id',
  `employee_id` BIGINT NOT NULL,
  `qrcode_id` BIGINT NULL COMMENT '使用的二维码',
  `store_id` BIGINT NULL COMMENT '核销门店',
  `verify_time` DATETIME NOT NULL COMMENT '核销时间',
  `deduct_quota` INT NOT NULL DEFAULT 1 COMMENT '本次扣减次数',
  `verifier_id` BIGINT NULL COMMENT '核销员 id',
  `rule_id` BIGINT NULL COMMENT '归属的时段规则；空=核销时无时段限制',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_company_time` (`company_id`, `verify_time`),
  KEY `idx_employee` (`employee_id`),
  KEY `idx_rule_employee_time` (`rule_id`, `employee_id`, `verify_time`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='核销/消费记录';

-- 核销二维码
CREATE TABLE IF NOT EXISTS `qr_codes` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `company_id` BIGINT NOT NULL,
  `employee_id` BIGINT NOT NULL,
  `type` TINYINT NOT NULL DEFAULT 2 COMMENT '1静态 / 2动态',
  `token` VARCHAR(64) NOT NULL COMMENT '二维码凭证',
  `status` TINYINT NOT NULL DEFAULT 1 COMMENT '1有效 / 0失效',
  `expire_at` DATETIME NULL COMMENT '动态码过期时间',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_token` (`token`),
  KEY `idx_employee_status` (`employee_id`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='核销二维码';

-- 核销门店
CREATE TABLE IF NOT EXISTS `stores` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(100) NOT NULL COMMENT '门店名',
  `company_id` BIGINT NULL COMMENT '空=平台通用店',
  `status` TINYINT NOT NULL DEFAULT 1,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='核销门店';

-- 管理员
CREATE TABLE IF NOT EXISTS `admins` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `username` VARCHAR(50) NOT NULL,
  `password_hash` VARCHAR(255) NOT NULL COMMENT 'bcrypt',
  `company_id` BIGINT NULL COMMENT '空=平台超管；非空=公司管理员',
  `role` VARCHAR(20) NOT NULL COMMENT 'super / company',
  `status` TINYINT NOT NULL DEFAULT 1,
  `token_version` INT NOT NULL DEFAULT 1 COMMENT '凭据版本：改密/停用即递增',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_username` (`username`),
  KEY `idx_company` (`company_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='管理员';

-- 核销设备（扫码枪 / 闸机）：一机一密钥，只存哈希
CREATE TABLE IF NOT EXISTS `devices` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(100) NOT NULL COMMENT '设备名称',
  `key_hash` VARCHAR(64) NOT NULL COMMENT '设备密钥 sha256（不存明文）',
  `key_prefix` VARCHAR(16) NOT NULL COMMENT '密钥前 8 位，仅列表辨识',
  `store_id` BIGINT NULL COMMENT '绑定门店；非空时核销以该门店为准',
  `company_id` BIGINT NULL COMMENT '可选归属公司',
  `status` TINYINT NOT NULL DEFAULT 1,
  `last_used_at` DATETIME NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_key_hash` (`key_hash`),
  KEY `idx_store` (`store_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='核销设备';

-- 核销时段限制规则
CREATE TABLE IF NOT EXISTS `verification_rules` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `company_id` BIGINT NOT NULL,
  `name` VARCHAR(50) NOT NULL COMMENT '时段名称',
  `start_time` VARCHAR(5) NOT NULL COMMENT 'HH:mm',
  `end_time` VARCHAR(5) NOT NULL COMMENT 'HH:mm；小于 start 表示跨天',
  `per_employee_limit` INT NOT NULL DEFAULT 1 COMMENT '每人该时段次数，0=不限',
  `status` TINYINT NOT NULL DEFAULT 1,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_company_status` (`company_id`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='核销时段限制规则';

-- 操作日志（只追加，不修改不删除）
CREATE TABLE IF NOT EXISTS `operation_logs` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `company_id` BIGINT NULL COMMENT '空=平台级操作',
  `module` VARCHAR(50) NOT NULL,
  `action` VARCHAR(50) NOT NULL,
  `description` VARCHAR(255) NULL COMMENT '人读文案',
  `operator_id` BIGINT NULL,
  `operator_name` VARCHAR(50) NULL COMMENT '操作人快照',
  `operator_role` VARCHAR(20) NULL COMMENT '操作人角色快照',
  `target_type` VARCHAR(50) NULL,
  `target_id` BIGINT NULL,
  `detail` TEXT NULL COMMENT '变更明细 JSON',
  `ip` VARCHAR(45) NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_company_time` (`company_id`, `created_at`),
  KEY `idx_operator` (`operator_id`),
  KEY `idx_module_action` (`module`, `action`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='操作日志';

-- 员工反馈（可见范围只到平台；公司端无任何接口）
CREATE TABLE IF NOT EXISTS `feedbacks` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `company_id` BIGINT NOT NULL,
  `employee_id` BIGINT NOT NULL,
  `employee_name` VARCHAR(50) NULL COMMENT '提交时姓名快照',
  `company_name` VARCHAR(100) NULL COMMENT '提交时公司名快照',
  `type` VARCHAR(20) NOT NULL DEFAULT 'issue' COMMENT 'issue/suggest/complaint/other',
  `title` VARCHAR(200) NOT NULL,
  `content` TEXT NOT NULL,
  `contact` VARCHAR(50) NULL COMMENT '联系方式，选填',
  `status` TINYINT NOT NULL DEFAULT 0 COMMENT '0待处理 1已处理',
  `reply` TEXT NULL COMMENT '平台回复',
  `reply_admin_id` BIGINT NULL,
  `reply_admin_name` VARCHAR(50) NULL,
  `replied_at` DATETIME NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_company_status` (`company_id`, `status`),
  KEY `idx_status_time` (`status`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='员工反馈（仅平台可见）';

SET FOREIGN_KEY_CHECKS = 1;
