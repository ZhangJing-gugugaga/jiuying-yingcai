CREATE TABLE taskRoutingRules (
  id TEXT PRIMARY KEY,
  owner TEXT,
  outlet TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active', 'disabled')),
  month TEXT,
  version INTEGER,
  current INTEGER NOT NULL DEFAULT 0,
  amount_cents INTEGER,
  data TEXT NOT NULL CHECK(json_valid(data)),
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX task_routing_scope ON taskRoutingRules (
  outlet,
  json_extract(data, '$.kind'),
  json_extract(data, '$.assigneeRole')
);

CREATE INDEX task_routing_active_outlet ON taskRoutingRules(outlet) WHERE status='active';
CREATE INDEX task_routing_support_claim ON businessTasks (
  json_extract(data, '$.recordId'),
  json_extract(data, '$.kind')
) WHERE status IN ('open','in_progress') AND json_extract(data, '$.kind') IN ('support_queue','support_sla');
