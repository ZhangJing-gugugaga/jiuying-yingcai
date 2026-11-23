CREATE TABLE work_contacts (
  staff_id TEXT NOT NULL REFERENCES staffAccounts(id),
  outlet TEXT NOT NULL REFERENCES outlets(id),
  role TEXT NOT NULL CHECK(role IN ('ops','finance','location','support','regional')),
  phone TEXT NOT NULL,
  published INTEGER NOT NULL CHECK(published IN (0,1)),
  is_default INTEGER NOT NULL CHECK(is_default IN (0,1)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(staff_id,outlet),
  CHECK(is_default=0 OR published=1)
);

CREATE UNIQUE INDEX work_contacts_outlet_default
  ON work_contacts(outlet) WHERE published=1 AND is_default=1;

CREATE INDEX work_contacts_current_task_link
  ON businessTasks(outlet,owner,json_extract(data,'$.businessType'),json_extract(data,'$.businessId'))
  WHERE status IN ('open','in_progress');
