import http from '@/utils/request';

/** 平台端 · 核销设备（一机一密钥） */
export const deviceApi = {
  list: () => http.get('/platform/devices'),
  /**
   * 登记设备。返回体里的 deviceKey 是**明文密钥，只出现这一次**。
   * 库里只存 sha256 —— 丢了只能换发，找不回来。
   */
  create: (data) => http.post('/platform/devices', data),
  update: (id, data) => http.put(`/platform/devices/${id}`, data),
  setStatus: (id, status) => http.put(`/platform/devices/${id}/status`, { status }),
  /** 换发密钥：返回新的明文密钥，同时旧密钥立即失效 */
  rotateKey: (id) => http.post(`/platform/devices/${id}/rotate-key`),
};
