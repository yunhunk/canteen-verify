/**
 * 本地零依赖模式使用的 SQLite 建表脚本。
 *
 * 与 sql/init.sql（MySQL 生产版）保持同构，差异只在方言：
 * - AUTO_INCREMENT → AUTOINCREMENT（且必须是 INTEGER PRIMARY KEY）
 * - DATETIME DEFAULT CURRENT_TIMESTAMP 保留（SQLite 支持）
 * - ON UPDATE CURRENT_TIMESTAMP 不支持 → 由应用层 updated_at 维护
 * - TINYINT / BIGINT → INTEGER（SQLite 动态类型）
 *
 * npm run check:schema 会比对两份脚本的表与列集合，防止漂移。
 */
const TABLES = [
  `CREATE TABLE IF NOT EXISTS companies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    contact_name TEXT,
    contact_phone TEXT,
    plan_id INTEGER,
    total_quota INTEGER NOT NULL DEFAULT 0,
    remain_quota INTEGER NOT NULL DEFAULT 0,
    meal_standard REAL,
    status INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_company_status ON companies (status, id)`,
  `CREATE TABLE IF NOT EXISTS plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    quota INTEGER NOT NULL DEFAULT 0,
    price REAL NOT NULL DEFAULT 0,
    valid_days INTEGER NOT NULL DEFAULT 0,
    status INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS employees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    openid TEXT,
    employee_no TEXT,
    status INTEGER NOT NULL DEFAULT 1,
    token_version INTEGER NOT NULL DEFAULT 1,
    quota_total INTEGER,
    quota_used INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uk_phone ON employees (phone)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uk_openid ON employees (openid)`,
  `CREATE INDEX IF NOT EXISTS idx_employees_company ON employees (company_id, status)`,
  `CREATE TABLE IF NOT EXISTS consumptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL,
    employee_id INTEGER NOT NULL,
    qrcode_id INTEGER,
    store_id INTEGER,
    verify_time DATETIME NOT NULL,
    deduct_quota INTEGER NOT NULL DEFAULT 1,
    verifier_id INTEGER,
    rule_id INTEGER,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_company_time ON consumptions (company_id, verify_time)`,
  `CREATE INDEX IF NOT EXISTS idx_employee ON consumptions (employee_id)`,
  `CREATE INDEX IF NOT EXISTS idx_rule_employee_time ON consumptions (rule_id, employee_id, verify_time)`,
  `CREATE TABLE IF NOT EXISTS qr_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL,
    employee_id INTEGER NOT NULL,
    type INTEGER NOT NULL DEFAULT 2,
    token TEXT NOT NULL,
    status INTEGER NOT NULL DEFAULT 1,
    expire_at DATETIME,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uk_token ON qr_codes (token)`,
  `CREATE INDEX IF NOT EXISTS idx_qr_employee ON qr_codes (employee_id, status)`,
  `CREATE TABLE IF NOT EXISTS stores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    company_id INTEGER,
    status INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    company_id INTEGER,
    role TEXT NOT NULL,
    status INTEGER NOT NULL DEFAULT 1,
    token_version INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uk_username ON admins (username)`,
  `CREATE TABLE IF NOT EXISTS devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    key_hash TEXT NOT NULL,
    key_prefix TEXT NOT NULL,
    store_id INTEGER,
    company_id INTEGER,
    status INTEGER NOT NULL DEFAULT 1,
    last_used_at DATETIME,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uk_key_hash ON devices (key_hash)`,
  `CREATE INDEX IF NOT EXISTS idx_devices_store ON devices (store_id)`,
  `CREATE TABLE IF NOT EXISTS verification_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    per_employee_limit INTEGER NOT NULL DEFAULT 1,
    status INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_rules_company ON verification_rules (company_id, status)`,
  `CREATE TABLE IF NOT EXISTS operation_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER,
    module TEXT NOT NULL,
    action TEXT NOT NULL,
    description TEXT,
    operator_id INTEGER,
    operator_name TEXT,
    operator_role TEXT,
    target_type TEXT,
    target_id INTEGER,
    detail TEXT,
    ip TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_logs_company_time ON operation_logs (company_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_logs_operator ON operation_logs (operator_id)`,
  `CREATE INDEX IF NOT EXISTS idx_logs_module_action ON operation_logs (module, action)`,
  `CREATE TABLE IF NOT EXISTS feedbacks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL,
    employee_id INTEGER NOT NULL,
    employee_name TEXT,
    company_name TEXT,
    type TEXT NOT NULL DEFAULT 'issue',
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    contact TEXT,
    status INTEGER NOT NULL DEFAULT 0,
    reply TEXT,
    reply_admin_id INTEGER,
    reply_admin_name TEXT,
    replied_at DATETIME,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_feedbacks_company_status ON feedbacks (company_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_feedbacks_status_time ON feedbacks (status, created_at)`,
];

const SEED = [
  `INSERT INTO plans (id, name, quota, price, valid_days, status) VALUES (1, '基础套餐 100 次', 100, 1980.00, 365, 1)`,
  `INSERT INTO plans (id, name, quota, price, valid_days, status) VALUES (2, '标准套餐 500 次', 500, 8800.00, 365, 1)`,
];

module.exports = { TABLES, SEED };
