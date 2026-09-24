/**
 * 重置本地演示数据库
 *
 * 冒烟测试会真实地修改数据（建公司、停账号、删超管……），
 * 跑几轮之后库里就全是测试残留，再跑必然误报。
 * 所以每次冒烟前先重置到干净的种子状态。
 *
 * 用法：node scripts/reset-local-db.js
 */
const fs = require('fs');
const path = require('path');

const dbFile = path.join(__dirname, '..', 'local.db');
const bakFile = path.join(__dirname, '..', 'local.db.bak');

if (fs.existsSync(dbFile)) {
  // 先改名再让调用方删除，避免被运行中的进程句柄锁住
  try {
    fs.renameSync(dbFile, bakFile);
    console.log('[reset] 旧库已改名为 local.db.bak');
  } catch (e) {
    console.error('[reset] 无法移动旧库（服务可能仍在运行）：', e.message);
    process.exit(1);
  }
  try {
    fs.unlinkSync(bakFile);
  } catch (_) {
    /* 删除失败也无妨，下次启动不会读到它 */
  }
}

console.log('[reset] 本地数据库已重置，下次启动将重新灌入种子数据');
