import { open, readFile, lstat, realpath, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readLibrary } from './src/library.js';
import { MAX_BACKUP_BYTES } from './src/family.js';

const filename = 'family-tree-library.json';
const fingerprint = (...values) => createHash('sha256').update(JSON.stringify(values)).digest('hex');
const failure = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
async function readRegular(path, limit, optional = false) {
  let info;
  try { info = await lstat(path); } catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
  if (!info.isFile() || info.isSymbolicLink()) throw failure(400, '存档或配置必须是普通文件，不能是文件夹或符号链接');
  if (info.size > limit) throw failure(413, '存档或配置超过容量限制');
  return readFile(path, 'utf8');
}
function clean(input) {
  try {
    const library = readLibrary(JSON.stringify(input));
    if (Buffer.byteLength(JSON.stringify(library), 'utf8') > MAX_BACKUP_BYTES) throw new Error('全部家谱规范化后超过存档容量（15 MB），请减少照片');
    return library;
  } catch (error) { throw failure(400, error.message); }
}
async function writeNew(path, text) {
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(text, 'utf8'); await handle.sync(); }
  catch (error) { await handle.close(); await unlink(path).catch(() => {}); throw error; }
  await handle.close();
}
async function replaceAtomically(path, text) {
  await readRegular(path, MAX_BACKUP_BYTES, true);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeNew(temporary, text); await rename(temporary, path); }
  finally { await unlink(temporary).catch(() => {}); }
}

export function createDiskLibrary(configPath) {
  async function inspect() {
    const configText = await readRegular(configPath, 8192, true);
    if (configText === null) return { mode: 'browser', path: '', revision: fingerprint(null), library: null, configText };
    let config;
    try { config = JSON.parse(configText); } catch { throw failure(503, '保存位置配置损坏，已停止写入；请保留配置与家谱文件'); }
    if (config.version !== 1 || typeof config.directory !== 'string' || !isAbsolute(config.directory)) throw failure(503, '保存位置配置无效，已停止写入');
    const path = join(config.directory, filename);
    let text;
    try { text = await readRegular(path, MAX_BACKUP_BYTES); }
    catch (error) { throw failure(503, `无法读取指定存档：${path}（${error.code || error.message}）。未切回浏览器存储，请恢复文件或磁盘后刷新`); }
    let library;
    try { library = readLibrary(text); } catch (error) { throw failure(503, `指定存档无效：${error.message}。原文件未修改，可检查同目录的 .bak 备份`); }
    return { mode: 'file', path, revision: fingerprint(configText, text), library, text, configText };
  }
  const publicState = ({ mode, path, revision, library }) => ({ mode, path, revision, library });
  async function withLock(action) {
    let handle;
    try { handle = await open(`${configPath}.lock`, 'wx', 0o600); }
    catch (error) {
      if (error.code === 'EEXIST') throw failure(423, '保存繁忙，请稍后重试。若服务曾异常退出，请停止所有家谱服务后清理配置旁的 .lock 文件');
      throw error;
    }
    try { return await action(); }
    finally { await handle.close(); await unlink(`${configPath}.lock`); }
  }
  function assertCurrent(state, revision) {
    if (typeof revision !== 'string' || revision !== state.revision) throw failure(409, '存档或保存位置已在其他页面更改，请刷新后重新编辑，以免覆盖更新');
  }
  return {
    async load() { return publicState(await inspect()); },
    async save({ library, revision }) {
      return withLock(async () => {
        const state = await inspect(); assertCurrent(state, revision);
        if (state.mode !== 'file') throw failure(409, '尚未设置文件保存位置');
        const text = JSON.stringify(clean(library));
        const backup = `${state.path}.bak`, previous = await readRegular(backup, MAX_BACKUP_BYTES, true);
        const rollback = `${backup}.${randomUUID()}.tmp`;
        let backupChanged = false, retainRollback = false;
        try {
          // Keep the previous backup until the new primary has committed.
          if (previous !== null) await writeNew(rollback, previous);
          await replaceAtomically(backup, state.text); backupChanged = true;
          // Recheck after backup I/O so an external edit is not overwritten knowingly.
          assertCurrent(await inspect(), revision);
          await replaceAtomically(state.path, text);
        } catch (error) {
          if (backupChanged) {
            try { if (previous === null) await unlink(backup); else await rename(rollback, backup); }
            catch {
              retainRollback = true;
              throw failure(503, `保存失败且无法还原备份，主存档未被本次操作替换。${previous === null ? '请保留现有 .bak 文件' : `上一版备份保留在：${rollback}`}。请停止服务并检查文件权限后恢复`);
            }
          }
          throw error;
        } finally { if (!retainRollback) await unlink(rollback).catch(() => {}); }
        return publicState(await inspect());
      });
    },
    async select({ directory, library, revision, openExisting = false, targetRevision }) {
      return withLock(async () => {
        const state = await inspect(); assertCurrent(state, revision);
        if (typeof directory !== 'string' || !isAbsolute(directory.trim())) throw failure(400, '请输入已存在文件夹的完整绝对路径');
        directory = await realpath(directory.trim());
        if (!(await lstat(directory)).isDirectory()) throw failure(400, '保存位置必须是文件夹');
        const path = join(directory, filename);
        if (path === state.path) return publicState(state);
        const target = await readRegular(path, MAX_BACKUP_BYTES, true);
        if (target !== null) {
          if (!openExisting) throw failure(409, '目标文件夹已有家谱存档。可确认打开它；不会合并或覆盖，原位置的资料仍保留。', { code: 'TARGET_EXISTS', targetRevision: fingerprint(path, target) });
          if (targetRevision !== fingerprint(path, target)) throw failure(409, '目标存档在确认期间发生变化，请重新选择');
          clean(readLibrary(target));
        } else {
          if (openExisting) throw failure(409, '要打开的存档已不存在，请重新选择');
          if (await readRegular(`${path}.bak`, MAX_BACKUP_BYTES, true) !== null) throw failure(409, '目标已有 .bak 备份，请先保管好备份或选择空文件夹');
          const text = JSON.stringify(clean(state.mode === 'file' ? state.library : library));
          // Exclusive creation never overwrites a file that appeared after the check.
          await writeNew(path, text);
        }
        // Publish the new location only after a complete, valid data file exists.
        await replaceAtomically(configPath, JSON.stringify({ version: 1, directory, id: randomUUID() }));
        return publicState(await inspect());
      });
    }
  };
}
