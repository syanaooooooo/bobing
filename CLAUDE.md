# 博饼分账 开发规则

## 项目信息
- **本地路径**：`/Users/o/Desktop/code/bobing/`
- **本地服务器**：`python3 -m http.server 8891 --directory /Users/o/Desktop/code/bobing`
- **工作分支**：`main`（直接推 main，GitHub Pages 自动部署）
- **CSS/JS 缓存**：改文件时 index.html 里对应的 `?v=N` 要加一

## 沟通方式
- 所有讨论用中文；代码注释、commit message 可中英混用
- 先 scope 后动手；改动前确认；不过度开发

## 云端架构
- 复用 fitness-tracker / baby-food-tracker 的 Supabase 项目
- 主数据：`snapshots` 表，`name='bobing_main'`
- localStorage key：`bobing_v1`
- 单写者（管理员），last-write-wins；访客只读
- 管理员：软密码门禁，密码哈希存 `S.admin_hash`（SHA-256），解锁态存 sessionStorage `bobing_admin`

## 数据模型（核心）
每笔账 = 谁垫钱(payers) + 为谁花+怎么分(split)：
```
expense = { id, date, title, category, amount,
  payers: [{person, paid}],           // 可多人，∑paid = amount
  split: { mode:'equal'|'shares'|'exact',
           among:[pid], shares:{pid:n}, exact:{pid:amt} } }
```
- 博饼奖金池当成一笔虚拟支出 `bobingItem()` 统一进结算
- `computeBalances()` 汇总每人净额 → `settle()` 最少转账算法
- 全部单一货币 SGD，手动统一录入（不折算）

## 文件
- index.html / style.css / app.js / sync.js / supabase-config.js
- 无构建，纯静态
