-- Settle against existing JSON records. Preserve prior status, reports and audit rows.
CREATE INDEX IF NOT EXISTS idx_settlements_month_status ON settlements(month,status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_resettlement_source
 ON businessTasks(json_extract(data,'$.businessId'))
 WHERE json_extract(data,'$.kind')='report_resettlement';

WITH periods AS MATERIALIZED (
 SELECT id,row_number() OVER (PARTITION BY month ORDER BY rowid) revision,
        lag(id) OVER (PARTITION BY month ORDER BY rowid) prior_id,
        lead(id) OVER (PARTITION BY month ORDER BY rowid) next_id
 FROM settlements
)
UPDATE settlements
SET version=periods.revision,
 data=json_patch(settlements.data,json_object('version',periods.revision,
      'previousSettlementId',periods.prior_id,'supersededBy',periods.next_id))
FROM periods
WHERE settlements.id=periods.id AND settlements.version IS NULL;

WITH open_periods AS MATERIALIZED (
 SELECT s.id prior_id,s.month,s.data,
        COALESCE(json_extract(s.data,'$.invalidatedAt'),s.created_at) observed_at,
        'task-resettlement-'||lower(hex(randomblob(16))) task_id
 FROM settlements s
 WHERE s.status='invalidated' AND json_extract(s.data,'$.supersededBy') IS NULL
   AND NOT EXISTS (SELECT 1 FROM settlements current WHERE current.month=s.month AND current.status='approved')
   AND NOT EXISTS (SELECT 1 FROM businessTasks task WHERE json_extract(task.data,'$.kind')='report_resettlement' AND json_extract(task.data,'$.businessId')=s.id)
), original_reports AS MATERIALIZED (
 SELECT p.prior_id,p.month,p.observed_at,r.id report_id,r.outlet,r.data
 FROM open_periods p,json_each(p.data,'$.reportIds') ref JOIN reports r ON r.id=ref.value
), report_changes AS MATERIALIZED (
 SELECT old.prior_id,old.outlet,
        CASE WHEN json_extract(old.data,'$.revoked') THEN 'report_revoked'
             WHEN current.id IS NOT NULL THEN 'report_corrected' ELSE 'legacy_report_change' END kind,
        COALESCE(json_extract(old.data,'$.revocationRequestId'),current.id,old.report_id) event_id,
        old.report_id previous_report_id,current.id report_id,old.observed_at
 FROM original_reports old LEFT JOIN reports current
 ON current.outlet=old.outlet AND current.month=old.month AND current.current=1 AND current.status='approved'
 WHERE current.id IS NULL OR current.id<>old.report_id
 UNION ALL
 SELECT p.prior_id,r.outlet,'report_approved',r.id,NULL,r.id,p.observed_at
 FROM open_periods p JOIN reports r ON r.month=p.month AND r.status='approved' AND r.current=1
 WHERE NOT EXISTS (SELECT 1 FROM original_reports old WHERE old.prior_id=p.prior_id AND old.outlet=r.outlet)
 UNION ALL
 SELECT old.prior_id,old.outlet,'summary_adjusted',a.id,old.report_id,old.report_id,old.observed_at
 FROM original_reports old JOIN summaryAdjustments a ON json_extract(a.data,'$.sourceReportId')=old.report_id AND a.status='approved'
 WHERE EXISTS (SELECT 1 FROM json_each(a.data,'$.trail') tr
       WHERE json_extract(tr.value,'$.action')='review.adjust'
       AND json_extract(tr.value,'$.after.status')='approved'
       AND json_extract(tr.value,'$.executedAt')>=old.observed_at)
), task_impacts AS MATERIALIZED (
 SELECT * FROM report_changes
 UNION ALL
 SELECT old.prior_id,old.outlet,'legacy_scope_unconfirmed',old.report_id,old.report_id,NULL,old.observed_at
 FROM original_reports old
 WHERE NOT EXISTS (SELECT 1 FROM report_changes change WHERE change.prior_id=old.prior_id)
)
INSERT INTO businessTasks(id,owner,outlet,status,month,data,created_at)
SELECT p.task_id,NULL,NULL,'open',p.month,json_object(
 'id',p.task_id,'owner',NULL,'outlet',NULL,'status','open','month',p.month,
 'kind','report_resettlement','queue','hq','role','manager','target','reports',
 'recordId',p.prior_id,'businessType','settlements','businessId',p.prior_id,'currentStage','report_resettlement',
 'responsibilityKey',json_array('settlements',p.prior_id),'assigneeType','role','assigneeRole','manager',
 'assigneeUserId',NULL,'assigneeFranchiseeId',NULL,'internal',json('true'),
 'title','历史月报待重新结算','dueOn',NULL,'dueAt',NULL,'createdAt',p.observed_at,'updatedAt',p.observed_at,
 'completedAt',NULL,'closeReason',NULL,'transferHistory',json('[]'),'initiator','system',
 'taskKey','report_resettlement|'||p.prior_id||'|','idempotencyKey','report_resettlement|'||p.prior_id||'|',
 'affectedOutletIds',json((SELECT json_group_array(outlet) FROM (SELECT DISTINCT outlet FROM task_impacts WHERE prior_id=p.prior_id ORDER BY outlet))),
 'impacts',json((SELECT json_group_array(json_object('outlet',outlet,'kind',kind,'eventId',event_id,
       'previousReportId',previous_report_id,'reportId',report_id,'at',observed_at,'source','legacy-backfill'))
       FROM task_impacts WHERE prior_id=p.prior_id))),p.observed_at
FROM open_periods p;

UPDATE settlements
SET data=json_set(settlements.data,'$.resettlementTaskId',task.id)
FROM businessTasks task
WHERE json_extract(task.data,'$.kind')='report_resettlement'
 AND json_extract(task.data,'$.businessId')=settlements.id
 AND json_extract(settlements.data,'$.resettlementTaskId') IS NULL;

-- Carry existing reminders into the operations queue. Read projections use the current server policy.
UPDATE businessTasks SET data=json_set(data,'$.queue','ops')
WHERE status IN ('open','in_progress') AND json_extract(data,'$.kind')='report_missing'
 AND json_extract(data,'$.queue') IS NULL
 AND json_extract(data,'$.businessType')='outlets';
