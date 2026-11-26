-- Add responsibility metadata to existing tasks and reconcile current stage from stored facts.
-- Existing task IDs, messages, domain records and audit events are retained.
CREATE INDEX idx_tasks_record_id ON businessTasks(json_extract(data,'$.recordId'));
CREATE INDEX idx_tasks_pending_fee_adjustment ON feeProposals(json_extract(data,'$.adjustmentId')) WHERE status='pending';

CREATE TEMP TABLE v32_current_work AS
WITH pending_fee AS MATERIALIZED (
 SELECT p.id,p.owner,p.outlet,COALESCE(p.month,json_extract(p.data,'$.offsetMonth')) month,a.id adjustment_id,
        row_number() OVER(PARTITION BY a.id ORDER BY p.rowid DESC) rank
 FROM feeProposals p JOIN adjustments a ON a.id=json_extract(p.data,'$.adjustmentId')
 WHERE p.status='pending' AND a.status='待财务核算调整'
)
SELECT CASE status WHEN 'pending' THEN 'report_review' WHEN 'finance' THEN 'report_finance_review' ELSE 'report_returned' END kind,
       CASE status WHEN 'pending' THEN 'ops' WHEN 'finance' THEN 'finance' ELSE 'partner' END queue,
       CASE status WHEN 'pending' THEN 'ops' WHEN 'finance' THEN 'finance' ELSE 'partner' END role,
       'reports' business_type, id business_id, owner, outlet, month, 'reports' target
FROM reports r
WHERE status IN ('pending','finance','returned')
  AND NOT EXISTS (SELECT 1 FROM reports later WHERE later.outlet=r.outlet AND later.month=r.month AND later.version>r.version)
UNION ALL
SELECT CASE WHEN status IN ('supplement','returned') THEN 'request_supplement'
            WHEN json_extract(data,'$.type') IN ('newOutlet','locationChange') AND json_extract(data,'$.data.locationStatus')='pending'
              THEN 'location_request_review' ELSE 'request_review' END,
       CASE WHEN status IN ('supplement','returned') THEN 'partner'
            WHEN json_extract(data,'$.type') IN ('pauseFee','exemptException','reportRevoke') THEN 'finance' ELSE 'hq' END,
       CASE WHEN status IN ('supplement','returned') THEN 'partner'
            WHEN json_extract(data,'$.type') IN ('newOutlet','locationChange') AND json_extract(data,'$.data.locationStatus')='pending'
              THEN 'location'
            WHEN json_extract(data,'$.type') IN ('pauseFee','exemptException','reportRevoke') THEN 'finance'
            WHEN json_extract(data,'$.type')='accountChange' THEN 'manager' ELSE 'ops' END,
       'requests', id, owner, outlet, COALESCE(month,json_extract(data,'$.data.month')), 'requests'
FROM requests
WHERE status='pending' OR (status IN ('supplement','returned') AND json_extract(data,'$.type')<>'reportRevoke')
UNION ALL
SELECT CASE status WHEN 'pending' THEN 'location_verification' ELSE 'location_exception' END,
       'hq','location','verifications',id,owner,outlet,month,'location'
FROM verifications v WHERE status IN ('pending','exception')
  AND NOT EXISTS (SELECT 1 FROM verifications later WHERE later.outlet=v.outlet AND later.month=v.month AND later.rowid>v.rowid)
UNION ALL
SELECT CASE status WHEN 'finance' THEN 'summary_finance_review' ELSE 'summary_review' END,
       CASE status WHEN 'finance' THEN 'finance' ELSE 'hq' END,
       CASE status WHEN 'finance' THEN 'finance' ELSE 'ops' END,
       'summaryAdjustments',id,owner,outlet,month,'reports'
FROM summaryAdjustments WHERE status IN ('pending','finance')
UNION ALL
SELECT 'fee_calculation','hq','ops','adjustments',id,owner,outlet,month,'fees'
FROM adjustments a WHERE status='待财务核算调整' AND NOT EXISTS (SELECT 1 FROM pending_fee p WHERE p.adjustment_id=a.id)
UNION ALL
SELECT 'fee_proposal_review','finance','finance','feeProposals',id,owner,outlet,month,'fees'
FROM pending_fee WHERE rank=1
UNION ALL
SELECT 'support_management','hq','manager','supportTickets',id,owner,outlet,month,'support'
FROM supportTickets WHERE status<>'closed' AND json_extract(data,'$.severe')=1
  AND COALESCE(json_extract(data,'$.managementHandled'),0)=0 AND json_extract(data,'$.assignee') IS NOT NULL
UNION ALL
SELECT 'support_management','hq','manager','supportChats',id,owner,outlet,month,'support'
FROM supportChats WHERE status<>'closed' AND json_extract(data,'$.severe')=1
  AND COALESCE(json_extract(data,'$.managementHandled'),0)=0 AND json_extract(data,'$.assignee') IS NOT NULL
UNION ALL
SELECT 'support_queue','hq','support','supportTickets',id,owner,outlet,month,'support'
FROM supportTickets t WHERE status='queued'
  AND NOT (COALESCE(json_extract(t.data,'$.severe'),0)=1 AND COALESCE(json_extract(t.data,'$.managementHandled'),0)=0 AND json_extract(t.data,'$.assignee') IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM businessTasks b WHERE b.status IN ('open','in_progress')
    AND json_extract(b.data,'$.kind')='support_sla' AND json_extract(b.data,'$.recordId')=t.id)
UNION ALL
SELECT 'support_queue','hq','support','supportChats',id,owner,outlet,month,'support'
FROM supportChats WHERE status='queued'
  AND NOT (COALESCE(json_extract(data,'$.severe'),0)=1 AND COALESCE(json_extract(data,'$.managementHandled'),0)=0 AND json_extract(data,'$.assignee') IS NOT NULL);

CREATE INDEX temp.v32_current_work_lookup ON v32_current_work(kind,business_id);

CREATE TEMP TABLE v32_legacy_task AS
WITH legacy AS (
 SELECT id,outlet,owner,month,status,created_at,data,
        json_extract(data,'$.kind') kind,json_extract(data,'$.role') role,
        json_extract(data,'$.recordId') record_id
 FROM businessTasks WHERE json_extract(data,'$.businessType') IS NULL
), types AS (
 SELECT *,
 CASE
  WHEN kind IN ('report_review','report_returned','metric_anomaly') THEN 'reports'
  WHEN kind IN ('request_review','request_supplement') THEN 'requests'
  WHEN kind='fee_calculation' THEN 'adjustments'
  WHEN kind IN ('bill_unpaid','bill_overdue') THEN 'bills'
  WHEN kind IN ('support_queue','support_reply','support_waiting','support_sla') THEN
   CASE WHEN EXISTS (SELECT 1 FROM supportChats WHERE id=record_id) THEN 'supportChats' ELSE 'supportTickets' END
  WHEN kind IN ('report_missing','exemption_review','location_missing','no_data') THEN 'outlets'
 END business_type,
 CASE
  WHEN kind='report_review' THEN 'ops'
  WHEN kind IN ('report_returned','request_supplement') THEN 'partner'
  WHEN kind IN ('fee_calculation','request_review') AND role='finance' THEN 'finance'
  WHEN kind IN ('fee_calculation','request_review','support_queue','support_sla','bill_overdue','location_missing','exemption_review','metric_anomaly','no_data') THEN 'hq'
 END queue
 FROM legacy
)
SELECT *,COALESCE(record_id,outlet) business_id FROM types WHERE business_type IS NOT NULL;

CREATE INDEX temp.v32_legacy_task_id ON v32_legacy_task(id);

UPDATE businessTasks AS task
SET month=COALESCE(work.month,old.month),
    data=json_set(task.data,
      '$.month',COALESCE(work.month,old.month),
      '$.queue',COALESCE(work.queue,old.queue),
      '$.businessType',old.business_type,
      '$.businessId',old.business_id,
      '$.currentStage',old.kind,
      '$.target',COALESCE(work.target,json_extract(old.data,'$.target'),
        CASE WHEN old.kind='location_missing' THEN 'location' WHEN old.business_type='bills' THEN 'fees'
             WHEN old.business_type IN ('supportTickets','supportChats') THEN 'support' ELSE 'reports' END),
      '$.assigneeType',CASE WHEN old.role='partner' THEN 'franchisee' WHEN json_extract(old.data,'$.assignee') IS NOT NULL THEN 'user' ELSE 'role' END,
      '$.assigneeRole',COALESCE(work.role,CASE WHEN old.kind='report_review' THEN 'ops' ELSE old.role END,'manager'),
      '$.assigneeUserId',json_extract(old.data,'$.assignee'),
      '$.assigneeFranchiseeId',CASE WHEN old.role='partner' THEN old.owner END,
      '$.dueAt',CASE WHEN old.kind NOT IN ('report_review','report_returned','request_review','request_supplement','fee_calculation','support_queue')
        THEN COALESCE(json_extract(old.data,'$.deadlineAt'),json_extract(old.data,'$.dueOn')) END,
      '$.eventId',NULL,'$.idempotencyKey',json_extract(old.data,'$.taskKey'),
      '$.createdAt',COALESCE(json_extract(old.data,'$.createdAt'),old.created_at),
      '$.updatedAt',COALESCE(json_extract(old.data,'$.updatedAt'),old.created_at),
      '$.completedAt',json_extract(old.data,'$.resolvedAt'),'$.closeReason',json_extract(old.data,'$.resolution'),
      '$.transferHistory',json('[]'))
FROM v32_legacy_task old LEFT JOIN v32_current_work work ON work.kind=old.kind AND work.business_id=old.business_id
 AND (old.kind<>'fee_calculation' OR old.role=work.role)
WHERE task.id=old.id;

-- Align current legacy rows to the same scope key generated on future stage transitions.
UPDATE businessTasks SET data=json_set(data,'$.responsibilityKey',
 CASE
  WHEN json_extract(data,'$.kind')='location_missing' THEN json_array('verifications',outlet,month)
  WHEN json_extract(data,'$.kind') IN ('report_review','report_returned','exemption_review','metric_anomaly') AND outlet IS NOT NULL AND month IS NOT NULL
    THEN json_array('reports',outlet,month)
  WHEN json_extract(data,'$.kind')='no_data' THEN json_array('no_data',outlet,month)
  ELSE json_array(json_extract(data,'$.businessType'),json_extract(data,'$.businessId')) END)
WHERE json_extract(data,'$.queue') IS NOT NULL;

-- Close outdated responsibility rows explicitly, without creating historical approvals or changing original source records.
UPDATE businessTasks AS task
SET status='resolved',data=json_set(data,'$.status','resolved',
     '$.resolvedAt',strftime('%Y-%m-%dT%H:%M:%fZ','now'),'$.completedAt',strftime('%Y-%m-%dT%H:%M:%fZ','now'),
     '$.updatedAt',strftime('%Y-%m-%dT%H:%M:%fZ','now'),'$.closeReason','migration_stage_reconciled','$.resolution','migration_stage_reconciled')
WHERE status IN ('open','in_progress') AND (
 (json_extract(data,'$.kind') IN ('report_review','report_returned','request_review','request_supplement','fee_calculation','support_queue')
  AND NOT EXISTS (SELECT 1 FROM v32_current_work w
    WHERE w.kind=json_extract(task.data,'$.kind') AND w.business_id=json_extract(task.data,'$.businessId')
      AND (w.kind<>'fee_calculation' OR w.role=json_extract(task.data,'$.assigneeRole'))))
 OR (json_extract(data,'$.kind')='location_missing' AND EXISTS (SELECT 1 FROM verifications v WHERE v.outlet=task.outlet AND v.month=task.month))
 OR (json_extract(data,'$.kind') IN ('report_missing','exemption_review') AND
    (EXISTS (SELECT 1 FROM reports r WHERE r.outlet=task.outlet AND r.month=task.month AND (r.status IN ('pending','finance','returned') OR r.current=1))
      OR EXISTS (SELECT 1 FROM exemptions e WHERE e.outlet=task.outlet AND e.month=task.month AND e.status='approved')))
 OR (json_extract(data,'$.kind')='metric_anomaly' AND
   NOT EXISTS (SELECT 1 FROM reports r WHERE r.id=json_extract(task.data,'$.businessId') AND r.current=1 AND r.status='approved'))
 OR (json_extract(data,'$.kind')='bill_overdue' AND
   NOT EXISTS (SELECT 1 FROM bills b WHERE b.id=json_extract(task.data,'$.businessId') AND b.status='unpaid'))
 OR (json_extract(data,'$.kind')='support_sla' AND
   (NOT EXISTS (SELECT 1 FROM supportTickets t WHERE t.id=json_extract(task.data,'$.businessId') AND t.status<>'closed' AND json_extract(t.data,'$.firstResponseAt') IS NULL)
    OR EXISTS (SELECT 1 FROM v32_current_work w WHERE w.kind='support_management' AND w.business_id=json_extract(task.data,'$.businessId'))))
);

-- If earlier versions stored overlapping current rows, keep the most recent stage and retain redundant rows as history.
WITH duplicates AS (
 SELECT id,row_number() OVER(PARTITION BY json_extract(data,'$.responsibilityKey')
   ORDER BY CASE WHEN json_extract(data,'$.kind')='support_sla' THEN 0 ELSE 1 END,created_at DESC,rowid DESC) rn
 FROM businessTasks WHERE status IN ('open','in_progress') AND json_extract(data,'$.responsibilityKey') IS NOT NULL
)
UPDATE businessTasks
SET status='resolved',data=json_set(data,'$.status','resolved',
    '$.resolvedAt',strftime('%Y-%m-%dT%H:%M:%fZ','now'),'$.completedAt',strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    '$.updatedAt',strftime('%Y-%m-%dT%H:%M:%fZ','now'),'$.closeReason','migration_duplicate','$.resolution','migration_duplicate')
WHERE id IN (SELECT id FROM duplicates WHERE rn>1);

CREATE UNIQUE INDEX idx_tasks_responsibility_current ON businessTasks(json_extract(data,'$.responsibilityKey'))
WHERE status IN ('open','in_progress') AND json_extract(data,'$.responsibilityKey') IS NOT NULL;

WITH candidates AS (
 SELECT *,CASE WHEN business_type='feeProposals' THEN json_array('adjustments',(SELECT json_extract(p.data,'$.adjustmentId') FROM feeProposals p WHERE p.id=v32_current_work.business_id))
    WHEN business_type IN ('reports','verifications') AND outlet IS NOT NULL AND month IS NOT NULL
    THEN json_array(business_type,outlet,month) ELSE json_array(business_type,business_id) END scope_key
 FROM v32_current_work
), missing AS MATERIALIZED (
 SELECT 'task-v32-'||lower(hex(randomblob(16))) id,w.*,
        w.kind||'|'||w.business_id||'|' task_key,strftime('%Y-%m-%dT%H:%M:%fZ','now') at
 FROM candidates w WHERE NOT EXISTS (SELECT 1 FROM businessTasks b WHERE b.status IN ('open','in_progress')
   AND json_extract(b.data,'$.responsibilityKey') IS NOT NULL AND json_extract(b.data,'$.responsibilityKey')=w.scope_key)
)
INSERT INTO businessTasks(id,owner,outlet,status,month,data,created_at)
SELECT id,owner,outlet,'open',month,json_object(
 'id',id,'owner',owner,'outlet',outlet,'month',month,'status','open','kind',kind,'queue',queue,'role',role,'target',target,
 'recordId',business_id,'businessType',business_type,'businessId',business_id,'currentStage',kind,
 'responsibilityKey',scope_key,'assigneeType',CASE WHEN role='partner' THEN 'franchisee' ELSE 'role' END,
 'assignee',NULL,'assigneeRole',role,'assigneeUserId',NULL,'assigneeFranchiseeId',CASE WHEN role='partner' THEN owner END,
 'internal',json(CASE WHEN role='partner' THEN 'false' ELSE 'true' END),'dueOn',NULL,'dueAt',NULL,
 'createdAt',at,'updatedAt',at,'completedAt',NULL,'closeReason',NULL,'transferHistory',json('[]'),'trail',json('[]'),
 'initiator','system','eventId',NULL,'taskKey',task_key,'idempotencyKey',task_key),at
FROM missing;

DROP TABLE v32_legacy_task;
DROP TABLE v32_current_work;

CREATE INDEX idx_tasks_queue_current ON businessTasks(json_extract(data,'$.queue'),outlet,month,created_at)
WHERE status IN ('open','in_progress');

CREATE TRIGGER business_tasks_transfer_history_immutable BEFORE UPDATE OF data ON businessTasks
WHEN EXISTS (SELECT 1 FROM json_each(OLD.data,'$.transferHistory') event
 WHERE json_extract(NEW.data,'$.transferHistory['||event.key||']') IS NOT event.value)
BEGIN
 SELECT RAISE(ABORT,'business task transfer history is immutable');
END;
CREATE TRIGGER business_tasks_transfer_history_no_delete BEFORE DELETE ON businessTasks
WHEN json_array_length(OLD.data,'$.transferHistory')>0
BEGIN
 SELECT RAISE(ABORT,'business task transfer history is immutable');
END;
