import { readLibrary } from './library.js';

export async function storageRequest(method = 'GET', body, suffix = '', fetcher = globalThis.fetch) {
  let response;
  try {
    response = await fetcher(`/api/storage${suffix}`, {
      method, credentials: 'same-origin', cache: 'no-store',
      headers: { 'X-Family-Tree': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
  } catch {
    throw new Error('无法连接本机家谱服务，本次操作未确认保存。请启动服务后刷新核对；不会改用浏览器保存');
  }
  let state;
  try { state = await response.json(); }
  catch { throw new Error('本机服务返回了无法识别的结果，请重启服务并刷新后核对存档'); }
  if (!response.ok) throw Object.assign(new Error(state.message || '读取或保存家谱失败'), { status: response.status, code: state.code, targetRevision: state.targetRevision });
  if (!state || !['browser', 'file'].includes(state.mode) || typeof state.revision !== 'string' || typeof state.path !== 'string') throw new Error('保存位置配置无效，已停止写入');
  if (state.mode === 'file') state.library = readLibrary(JSON.stringify(state.library));
  return state;
}
