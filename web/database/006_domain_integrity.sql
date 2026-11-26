-- Repair historical SLA tasks without deleting notifications, tasks or audit history.
-- Their internal ownership remains null; outlet is needed for scoped work and fact reconciliation.
UPDATE businessTasks
SET outlet=(SELECT outlet FROM supportTickets WHERE id=json_extract(businessTasks.data,'$.recordId')),
    owner=NULL,
    data=json_set(data,
      '$.outlet',(SELECT outlet FROM supportTickets WHERE id=json_extract(businessTasks.data,'$.recordId')),
      '$.owner',NULL,
      '$.internal',json('true'),
      '$.taskKey','support_sla|' || (SELECT outlet FROM supportTickets WHERE id=json_extract(businessTasks.data,'$.recordId')) || '|' || COALESCE(month,json_extract(data,'$.month'),'') || '|' || json_extract(data,'$.recordId'))
WHERE json_extract(data,'$.kind')='support_sla'
  AND outlet IS NULL
  AND EXISTS (SELECT 1 FROM supportTickets WHERE id=json_extract(businessTasks.data,'$.recordId') AND outlet IS NOT NULL);

-- Fail closed if historical duplicates exist: financial evidence must be reviewed, never silently deleted.
CREATE UNIQUE INDEX idx_invoice_red_number ON invoiceRequests(json_extract(data,'$.redNumber'))
WHERE json_extract(data,'$.redNumber') IS NOT NULL;
