import http from '@/utils/request';

/**
 * 平台端 · 员工反馈管理
 *
 * ⚠️ 只有平台超管有反馈接口 —— 公司端**没有**对应的 api 模块。
 * 这是刻意的：员工投诉的对象常常就是公司/食堂本身，
 * 若公司管理员能看到，这个功能就没人敢用了。
 */
export const feedbackApi = {
  /** 列表：分页 + 按公司/类型/状态/关键词筛选 */
  list: (params) => http.get('/platform/feedbacks', { params }),

  /** 待处理数量（菜单角标用） */
  pendingCount: () => http.get('/platform/feedbacks/pending-count'),

  /** 回复（顺带置为已处理） */
  reply: (id, reply) => http.put(`/platform/feedbacks/${id}/reply`, { reply }),

  /** 仅改状态 */
  setStatus: (id, status) => http.put(`/platform/feedbacks/${id}/status`, { status }),
};

/** 反馈类型 → 展示文案（与后端 TYPE_LABEL 对齐） */
export const FEEDBACK_TYPES = [
  { value: 'issue', label: '问题反馈', tag: 'warning' },
  { value: 'suggest', label: '功能建议', tag: 'primary' },
  { value: 'complaint', label: '投诉', tag: 'danger' },
  { value: 'other', label: '其他', tag: 'info' },
];
