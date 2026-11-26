-- Give proven franchisee actions their own responsibility. Keep headquarters rows and raw notices intact.
CREATE TEMP TABLE v33_partner_actions AS
WITH reminders AS (
 SELECT t.*,json_extract(t.data,'$.kind') kind,
        row_number() OVER(PARTITION BY json_extract(t.data,'$.kind'),t.outlet,t.month ORDER BY t.created_at DESC,t.rowid DESC) ordinal
 FROM businessTasks t JOIN outlets o ON o.id=t.outlet AND o.owner=t.owner
 WHERE t.status IN ('open','in_progress') AND t.owner IS NOT NULL AND t.month IS NOT NULL
   AND ((json_extract(t.data,'$.kind')='report_missing' AND json_extract(t.data,'$.queue')='ops'
       AND NOT EXISTS (SELECT 1 FROM reports r WHERE r.outlet=t.outlet AND r.month=t.month
         AND COALESCE(json_extract(r.data,'$.revoked'),0)=0 AND r.status IN ('pending','finance','returned','approved'))
       AND NOT EXISTS (SELECT 1 FROM exemptions e WHERE e.outlet=t.outlet AND e.month=t.month AND e.status='approved'))
    OR (json_extract(t.data,'$.kind')='location_missing' AND json_extract(t.data,'$.queue')='hq'
       AND o.status IN ('open','paused') AND NOT EXISTS (SELECT 1 FROM verifications v WHERE v.outlet=t.outlet AND v.month=t.month)))
), contacts AS (
 SELECT id,owner,outlet,month,status,data,created_at,'supportTickets' business_type FROM supportTickets
 UNION ALL
 SELECT id,owner,outlet,month,status,data,created_at,'supportChats' FROM supportChats
), partner_contacts AS (
 SELECT c.*,(SELECT max(CAST(m.key AS INTEGER)) FROM json_each(c.data,'$.messages') m
             WHERE json_extract(m.value,'$.actor') IN ('support','manager')) last_reply
 FROM contacts c WHERE c.status<>'closed'
  AND EXISTS (SELECT 1 FROM accounts a WHERE a.owner=c.owner AND a.status='active')
  AND (c.outlet IS NULL OR EXISTS (SELECT 1 FROM outlets o WHERE o.id=c.outlet AND o.owner=c.owner))
), support_actions AS (
 SELECT *,CASE status WHEN 'waiting' THEN 'support_waiting' ELSE 'support_reply' END kind,
        json_extract(data,'$.messages['||last_reply||'].at') reply_at
 FROM partner_contacts
 WHERE status='waiting' OR (last_reply IS NOT NULL
  AND COALESCE(json_extract(data,'$.replyAcknowledgedCount'),0)<=last_reply
  AND (json_extract(data,'$.replyAcknowledgedCount') IS NOT NULL OR json_extract(data,'$.replyAcknowledgedAt') IS NULL
     OR julianday(json_extract(data,'$.replyAcknowledgedAt'))<julianday(json_extract(data,'$.messages['||last_reply||'].at')))
  AND NOT EXISTS (SELECT 1 FROM json_each(data,'$.messages') m WHERE CAST(m.key AS INTEGER)>last_reply
    AND json_extract(m.value,'$.actor') NOT IN ('support','manager','faq')))
)
SELECT kind,'outlets' business_type,outlet business_id,NULL record_id,owner,outlet,month,
 CASE kind WHEN 'location_missing' THEN 'location' ELSE 'reports' END target,
 COALESCE(json_extract(data,'$.dueAt'),json_extract(data,'$.dueOn')) due_at,
 json_array('partner',kind,outlet,month) scope_key,
 'partner|'||COALESCE(json_extract(data,'$.taskKey'),kind||'|'||outlet||'|'||month||'|') task_key,
 created_at origin_at,NULL reply_sequence,NULL reply_at
FROM reminders WHERE ordinal=1
UNION ALL
SELECT 'location_exception','verifications',v.id,v.id,v.owner,v.outlet,v.month,'location',NULL,
 json_array('partner','location_exception',v.id),'location_exception|'||v.id||'|partner',v.created_at,NULL,NULL
FROM verifications v JOIN outlets o ON o.id=v.outlet AND o.owner=v.owner WHERE v.status='exception'
 AND NOT EXISTS (SELECT 1 FROM verifications later WHERE later.outlet=v.outlet AND later.month=v.month AND later.rowid>v.rowid)
UNION ALL
SELECT 'bill_unpaid','bills',b.id,b.id,b.owner,b.outlet,b.month,'fees',json_extract(b.data,'$.dueOn'),
 json_array('partner','bill_unpaid',b.id),'bill_unpaid|'||b.id||'|',b.created_at,NULL,NULL
FROM bills b JOIN outlets o ON o.id=b.outlet AND o.owner=b.owner WHERE b.status='unpaid'
UNION ALL
SELECT kind,business_type,id,id,owner,outlet,month,'support',NULL,json_array('partner','support',id),
 kind||'|'||id||'|'||CASE WHEN kind='support_reply' THEN last_reply+1 ELSE '' END,
 COALESCE(reply_at,created_at),CASE WHEN kind='support_reply' THEN last_reply+1 END,
 CASE WHEN kind='support_reply' THEN reply_at END
FROM support_actions;

CREATE INDEX temp.v33_partner_actions_by_scope ON v33_partner_actions(scope_key);

CREATE TEMP TABLE v33_partner_existing AS
WITH eligible AS (
 SELECT t.id,action.scope_key,action.due_at,action.reply_sequence,action.reply_at,
  row_number() OVER(PARTITION BY action.scope_key ORDER BY COALESCE(json_extract(t.data,'$.queue')='partner',0) DESC,t.created_at DESC,t.rowid DESC) ordinal
 FROM v33_partner_actions action JOIN businessTasks t ON json_extract(t.data,'$.kind')=action.kind
  AND t.owner=action.owner AND t.outlet IS action.outlet
  AND COALESCE(json_extract(t.data,'$.businessId'),json_extract(t.data,'$.recordId'),t.outlet)=action.business_id
 WHERE t.status IN ('open','in_progress') AND COALESCE(json_extract(t.data,'$.internal'),0)=0
  AND (json_extract(t.data,'$.responsibilityKey')=action.scope_key
    OR (json_extract(t.data,'$.queue') IS NULL AND action.kind IN ('bill_unpaid','support_waiting','support_reply')))
  AND (action.kind<>'support_reply' OR json_extract(t.data,'$.replySequence')=action.reply_sequence
    OR json_extract(t.data,'$.replySequence') IS NULL AND json_extract(t.data,'$.replyAt')=action.reply_at)
)
SELECT id,scope_key,due_at,reply_sequence,reply_at FROM eligible WHERE ordinal=1;

UPDATE businessTasks AS task
SET data=json_set(task.data,'$.queue','partner','$.role','partner','$.assigneeRole','partner',
 '$.assigneeType','franchisee','$.assigneeFranchiseeId',task.owner,'$.assignee',NULL,'$.assigneeUserId',NULL,
 '$.responsibilityKey',existing.scope_key,'$.dueAt',existing.due_at,'$.dueOn',existing.due_at,
 '$.replySequence',existing.reply_sequence,'$.replyAt',existing.reply_at)
FROM v33_partner_existing existing WHERE task.id=existing.id;

WITH missing AS MATERIALIZED (
 SELECT 'task-v33-'||lower(hex(randomblob(16))) id,action.* FROM v33_partner_actions action
 WHERE NOT EXISTS (SELECT 1 FROM v33_partner_existing current WHERE current.scope_key=action.scope_key)
)
INSERT INTO businessTasks(id,owner,outlet,status,month,data,created_at)
SELECT id,owner,outlet,'open',month,json_object(
 'id',id,'owner',owner,'outlet',outlet,'month',month,'status','open','kind',kind,'queue','partner','role','partner','target',target,
 'recordId',record_id,'businessType',business_type,'businessId',business_id,'currentStage',kind,'responsibilityKey',scope_key,
 'assigneeType','franchisee','assignee',NULL,'assigneeRole','partner','assigneeUserId',NULL,'assigneeFranchiseeId',owner,
 'internal',json('false'),'dueOn',due_at,'dueAt',due_at,'replySequence',reply_sequence,'replyAt',reply_at,
 'createdAt',origin_at,'updatedAt',origin_at,'completedAt',NULL,'closeReason',NULL,'transferHistory',json('[]'),'trail',json('[]'),
 'initiator','system','eventId',NULL,'taskKey',task_key,'idempotencyKey',task_key),origin_at
FROM missing;

DROP TABLE v33_partner_existing;
DROP TABLE v33_partner_actions;
