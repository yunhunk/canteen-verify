import { DataSource } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { ENTITIES, Admin, Company, Device, Employee, Plan, Store, VerificationRule } from './entities';
import { buildDataSourceOptions } from '../config/app.config';
import { loadConfig } from '../config/app.config';
import { hashDeviceKey } from '../modules/common/utils/device-key';

/**
 * 本地零依赖模式的建库流程
 *
 * 1. 用 Sqljs 数据源建库
 * 2. 用 synchronize 从实体生成表结构（等价于跑 local-schema.js，但少一层维护）
 * 3. 灌一份可直接演示的种子数据
 *
 * 只灌一次：库里已有超管账号就跳过，避免每次重启都重置密码。
 *
 * ⚠️ 安全（漏洞 724a4/51062）：本文件只在 **localMode** 下被调用，
 *    但它同时被打包进生产镜像，硬编码凭据会被静态扫描当成「真密码泄漏」。
 *    因此所有凭据改为从环境变量读取；本地未配置时才退回到演示值，
 *    且退回到演示值时日志会显式提示「仅限本地演示」。
 *    生产分支由 app.config.ts 的启动校验兜底（本函数不会在生产被调用）。
 */

/** 读取种子凭据：优先环境变量，本地缺省用演示值 */
function seedCredential(envKey: string, fallback: string): string {
  const v = process.env[envKey];
  return v && v.trim() ? v.trim() : fallback;
}

export async function ensureDatabase(): Promise<void> {
  const config = loadConfig();
  const ds = new DataSource(buildDataSourceOptions(config) as any);
  await ds.initialize();

  await ds.synchronize();

  const adminRepo = ds.getRepository(Admin);
  const existing = await adminRepo.count();
  if (existing > 0) {
    await ds.destroy();
    return;
  }

  // 种子凭据（漏洞 724a4/51062）：全部走环境变量，本地演示值仅作兜底
  const superPwd = seedCredential('SEED_SUPER_PASSWORD', 'admin123456');
  const companyPwd = seedCredential('SEED_COMPANY_PASSWORD', 'company123456');
  const deviceKey1 = seedCredential('SEED_DEVICE_KEY_1', 'device-key-demo-0001');
  const deviceKey2 = seedCredential('SEED_DEVICE_KEY_2', 'device-key-demo-0002');

  const companyRepo = ds.getRepository(Company);
  const planRepo = ds.getRepository(Plan);
  const storeRepo = ds.getRepository(Store);
  const deviceRepo = ds.getRepository(Device);
  const ruleRepo = ds.getRepository(VerificationRule);
  const employeeRepo = ds.getRepository(Employee);

  // 套餐
  const planBasic = await planRepo.save(
    planRepo.create({ name: '基础套餐 100 次', quota: 100, price: '1980.00', valid_days: 365, status: 1 }),
  );
  await planRepo.save(
    planRepo.create({ name: '标准套餐 500 次', quota: 500, price: '8800.00', valid_days: 365, status: 1 }),
  );

  // 公司
  const companyA = await companyRepo.save(
    companyRepo.create({
      name: '示例科技有限公司',
      contact_name: '张经理',
      contact_phone: '13800000001',
      plan_id: String(planBasic.id),
      total_quota: 100,
      remain_quota: 100,
      status: 1,
    }),
  );
  const companyB = await companyRepo.save(
    companyRepo.create({
      name: '另一家制造企业',
      contact_name: '李主管',
      contact_phone: '13800000002',
      plan_id: String(planBasic.id),
      total_quota: 50,
      remain_quota: 50,
      status: 1,
    }),
  );

  // 管理员：超管 + 两家公司管理员
  await adminRepo.save([
    adminRepo.create({
      username: 'admin',
      password_hash: await bcrypt.hash(superPwd, 10),
      company_id: null,
      role: 'super',
      status: 1,
      token_version: 1,
    }),
    adminRepo.create({
      username: 'company_a',
      password_hash: await bcrypt.hash(companyPwd, 10),
      company_id: String(companyA.id),
      role: 'company',
      status: 1,
      token_version: 1,
    }),
    adminRepo.create({
      username: 'company_b',
      password_hash: await bcrypt.hash(companyPwd, 10),
      company_id: String(companyB.id),
      role: 'company',
      status: 1,
      token_version: 1,
    }),
  ]);

  // 门店
  const store1 = await storeRepo.save(
    storeRepo.create({ name: '总部食堂', company_id: null, status: 1 }),
  );
  await storeRepo.save(storeRepo.create({ name: '研发中心餐厅', company_id: null, status: 1 }));
  await storeRepo.save(storeRepo.create({ name: '制造基地食堂', company_id: null, status: 1 }));

  // 设备：一台绑店、一台不绑店，便于验证「设备绑店优先」
  await deviceRepo.save([
    deviceRepo.create({
      name: '总部食堂闸机 01',
      key_hash: hash(deviceKey1),
      key_prefix: deviceKey1.slice(0, 8),
      store_id: String(store1.id),
      company_id: null,
      status: 1,
    }),
    deviceRepo.create({
      name: '移动扫码枪 01',
      key_hash: hash(deviceKey2),
      key_prefix: deviceKey2.slice(0, 8),
      store_id: null,
      company_id: null,
      status: 1,
    }),
  ]);

  // 时段规则：给 A 公司配一个「午餐限 1 次」+「全天不限」的组合
  await ruleRepo.save([
    ruleRepo.create({
      company_id: String(companyA.id),
      name: '午餐',
      start_time: '11:00',
      end_time: '13:30',
      per_employee_limit: 1,
      status: 1,
    }),
    ruleRepo.create({
      company_id: String(companyA.id),
      name: '晚餐',
      start_time: '17:00',
      end_time: '19:30',
      per_employee_limit: 1,
      status: 1,
    }),
  ]);

  // 员工
  await employeeRepo.save([
    employeeRepo.create({
      company_id: String(companyA.id),
      name: '张三',
      phone: '13900000001',
      employee_no: 'A0001',
      status: 1,
    }),
    employeeRepo.create({
      company_id: String(companyA.id),
      name: '李四',
      phone: '13900000002',
      employee_no: 'A0002',
      status: 1,
    }),
    employeeRepo.create({
      company_id: String(companyB.id),
      name: '王五',
      phone: '13900000003',
      employee_no: 'B0001',
      status: 1,
    }),
  ]);

  await ds.destroy();

  // 只在本地演示模式下打印明文凭据；生产分支不会走到这里，且日志中不出现真实密码。
  const isDemo = !process.env.SEED_SUPER_PASSWORD && !process.env.SEED_COMPANY_PASSWORD;
  // eslint-disable-next-line no-console
  console.log(
    '[local] 已初始化本地演示数据（仅供本地演示，切勿用于生产）：\n' +
      `       平台超管 admin / ${isDemo ? superPwd : '<SEED_SUPER_PASSWORD>'}\n` +
      `       A 公司管理员 company_a / ${isDemo ? companyPwd : '<SEED_COMPANY_PASSWORD>'}\n` +
      `       B 公司管理员 company_b / ${isDemo ? companyPwd : '<SEED_COMPANY_PASSWORD>'}\n` +
      `       设备密钥 ${isDemo ? `${deviceKey1}（绑总部食堂）/ ${deviceKey2}（不绑店）` : '<SEED_DEVICE_KEY_1/2>'}`,
  );
}

function hash(plain: string): string {
  // 与 DeviceService / VerifyService 写入时用的哈希保持一致（v2$ + scrypt）
  return hashDeviceKey(plain);
}
