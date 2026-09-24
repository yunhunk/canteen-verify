import { DataSource } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { ENTITIES, Admin, Company, Device, Employee, Plan, Store, VerificationRule } from './entities';
import { buildDataSourceOptions } from '../config/app.config';
import { loadConfig } from '../config/app.config';

/**
 * 本地零依赖模式的建库流程
 *
 * 1. 用 Sqljs 数据源建库
 * 2. 用 synchronize 从实体生成表结构（等价于跑 local-schema.js，但少一层维护）
 * 3. 灌一份可直接演示的种子数据
 *
 * 只灌一次：库里已有超管账号就跳过，避免每次重启都重置密码。
 */
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
      password_hash: await bcrypt.hash('admin123456', 10),
      company_id: null,
      role: 'super',
      status: 1,
      token_version: 1,
    }),
    adminRepo.create({
      username: 'company_a',
      password_hash: await bcrypt.hash('company123456', 10),
      company_id: String(companyA.id),
      role: 'company',
      status: 1,
      token_version: 1,
    }),
    adminRepo.create({
      username: 'company_b',
      password_hash: await bcrypt.hash('company123456', 10),
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
      key_hash: hash('device-key-demo-0001'),
      key_prefix: 'device-k',
      store_id: String(store1.id),
      company_id: null,
      status: 1,
    }),
    deviceRepo.create({
      name: '移动扫码枪 01',
      key_hash: hash('device-key-demo-0002'),
      key_prefix: 'device-k',
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

  // eslint-disable-next-line no-console
  console.log(
    '[local] 已初始化本地演示数据：\n' +
      '       平台超管 admin / admin123456\n' +
      '       A 公司管理员 company_a / company123456\n' +
      '       B 公司管理员 company_b / company123456\n' +
      '       设备密钥 device-key-demo-0001（绑总部食堂）/ device-key-demo-0002（不绑店）',
  );
}

function hash(plain: string): string {
  // 与 VerifyService.hashDeviceKey 保持一致
  return require('crypto').createHash('sha256').update(plain).digest('hex');
}
