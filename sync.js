// sync.js — 博饼分账云端读写
// 主数据：snapshots 表，name='bobing_main'（与 fitness 的 ft_main 同表不同名）
// 只有管理员会写；访客只读。单写者，last-write-wins 足够。

const CLOUD_NAME = 'bobing_main';

// ─── 从云端加载 ───────────────────────────────────────────────
async function loadFromCloud() {
  const { data, error } = await window.sbClient
    .from('snapshots')
    .select('data')
    .eq('name', CLOUD_NAME)
    .maybeSingle();
  if (error) { console.warn('云端加载错误:', error.message); return null; }
  return data?.data || null;
}

// ─── 保存到云端 ───────────────────────────────────────────────
async function saveToCloud(payload) {
  // 先 update，影响 0 行说明记录不存在，改 insert
  const { data: updated, error: ue } = await window.sbClient
    .from('snapshots').update({ data: payload }).eq('name', CLOUD_NAME).select('name');
  if (ue) { console.warn('云端更新失败:', ue.message); return false; }
  if (!updated || updated.length === 0) {
    const { error: ie } = await window.sbClient
      .from('snapshots').insert({ name: CLOUD_NAME, data: payload });
    if (ie) { console.warn('云端插入失败:', ie.message); return false; }
  }
  return true;
}

// ─── 备份快照 ─────────────────────────────────────────────
// 命名：bobing_slot_1/2/3（手动存档位）| bobing_auto_YYYY-MM-DD（每日自动）
//       | bobing_pre_restore_<ISO>（恢复前安全备份）
async function saveSnapshot(name, data) {
  // 存档位 / 每日自动：先删同名，保证唯一不堆积
  if (name.startsWith('bobing_slot_') || name.startsWith('bobing_auto_')) {
    await window.sbClient.from('snapshots').delete().eq('name', name);
  }
  const { error } = await window.sbClient.from('snapshots').insert({ name, data });
  if (error) throw new Error('备份失败: ' + error.message);
}

// 加载所有 bobing_ 快照（排除主数据 bobing_main）
async function loadSnapshots() {
  const { data, error } = await window.sbClient
    .from('snapshots')
    .select('id, name, data, created_at')
    .like('name', 'bobing_%')
    .neq('name', 'bobing_main')
    .order('created_at', { ascending: false });
  if (error) { console.warn('快照加载失败:', error.message); return []; }
  return data || [];
}

// 读取单个快照数据
async function getSnapshot(name) {
  const { data, error } = await window.sbClient
    .from('snapshots').select('data').eq('name', name).maybeSingle();
  if (error) { console.warn('读取快照失败:', error.message); return null; }
  return data?.data || null;
}

// 删除快照
async function deleteSnapshot(name) {
  const { error } = await window.sbClient.from('snapshots').delete().eq('name', name);
  if (error) throw new Error('删除失败: ' + error.message);
}

window.loadFromCloud = loadFromCloud;
window.saveToCloud = saveToCloud;
window.saveSnapshot = saveSnapshot;
window.loadSnapshots = loadSnapshots;
window.getSnapshot = getSnapshot;
window.deleteSnapshot = deleteSnapshot;
