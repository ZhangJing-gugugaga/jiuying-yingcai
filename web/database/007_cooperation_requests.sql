-- Private cooperation enquiries. Public users can read only their own authenticated visitor subject.
CREATE TABLE cooperationRequests (id TEXT PRIMARY KEY, owner TEXT, outlet TEXT, status TEXT NOT NULL, month TEXT, version INTEGER, current INTEGER NOT NULL DEFAULT 0, amount_cents INTEGER, data TEXT NOT NULL CHECK(json_valid(data)), created_at TEXT NOT NULL);
CREATE INDEX idx_cooperationRequests_owner_status ON cooperationRequests(owner,status);
CREATE INDEX idx_cooperationRequests_outlet_month ON cooperationRequests(outlet,month);
