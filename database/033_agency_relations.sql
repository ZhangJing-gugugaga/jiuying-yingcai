-- 033: 分级代理报送。加盟主体级别保存在 organizations.data，直属关系独立成表并保留换绑历史。
-- 历史主体没有 level 字段，读取时按「未设置」处理，不推断代理级别。
CREATE TABLE agencyRelations (
  id TEXT PRIMARY KEY,
  owner TEXT,
  outlet TEXT,
  status TEXT NOT NULL,
  month TEXT,
  version INTEGER,
  current INTEGER NOT NULL DEFAULT 0,
  amount_cents INTEGER,
  data TEXT NOT NULL CHECK(json_valid(data)),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_agencyRelations_owner_status ON agencyRelations(owner,status);
CREATE INDEX idx_agencyRelations_parent ON agencyRelations(json_extract(data,'$.parentOwner'),status);
-- 同一二级主体同时只能有一条生效直属关系；解绑后保留历史记录。
CREATE UNIQUE INDEX agency_relation_active_child ON agencyRelations(owner) WHERE status='active';