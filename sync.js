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

window.loadFromCloud = loadFromCloud;
window.saveToCloud = saveToCloud;
