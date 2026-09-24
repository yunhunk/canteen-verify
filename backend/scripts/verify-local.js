/**
 * 启动服务 → 跑冒烟 → 停服务，一条命令闭环。
 *
 * 为什么要这样：服务进程必须在冒烟测试期间存活。
 * 在工具调用里用 `&` 起的后台进程会随该次 shell 会话结束被回收，
 * 于是"先起服务、再跑测试"分成两条命令时，第二条必然连不上。
 *
 * 用法：node scripts/verify-local.js [--fresh]
 *   --fresh  先重置数据库（推荐，避免上轮测试残留干扰断言）
 */
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const PORT = process.env.PORT || '3311';
const NODE = process.execPath;

const fresh = process.argv.includes('--fresh');

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', ...opts });
}

function main() {
  // 1. 确保有编译产物
  if (!fs.existsSync(path.join(ROOT, 'dist', 'main.js'))) {
    console.log('[verify] 未找到 dist/main.js，先编译…');
    run(NODE, [path.join('node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json']);
  }

  // 2. 可选：重置数据库
  if (fresh) {
    run(NODE, [path.join('scripts', 'reset-local-db.js')]);
  }

  // 3. 起服务
  console.log(`[verify] 启动服务（端口 ${PORT}）…`);
  const server = spawn(NODE, [path.join('dist', 'main.js')], {
    cwd: ROOT,
    env: { ...process.env, LOCAL_MODE: '1', PORT },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let serverLog = '';
  server.stdout.on('data', (d) => (serverLog += d.toString()));
  server.stderr.on('data', (d) => (serverLog += d.toString()));

  // 4. 等就绪后跑冒烟
  waitFor(PORT, 40_000)
    .then(() => {
      console.log('[verify] 服务已就绪，开始冒烟测试…\n');
      const r = run(NODE, [path.join('scripts', 'smoke.js')]);
      server.kill();
      console.log(`[verify] 服务已停止（退出码 ${r.status}）`);
      process.exit(r.status || 0);
    })
    .catch(() => {
      console.error('\n[verify] 服务启动失败，日志如下：\n');
      console.error(serverLog.split('\n').slice(-25).join('\n'));
      server.kill();
      process.exit(1);
    });
}

async function waitFor(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}/api/platform/companies`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  throw new Error('timeout');
}

main();
