'use strict';

const { previousMonth, reportMonthStatus } = require('../shared/operations.cjs');

function addOutletSummaries(db, outlets, owner, today) {
  if (!outlets.length) return;
  const period = today.slice(0, 7), reportMonth = previousMonth(period);
  const rows = db.prepare(`
    WITH page(id) AS (SELECT value FROM json_each(?)),
    parameters(owner,report_month,current_month) AS (VALUES (?,?,?))
    SELECT page.id,
      EXISTS (SELECT 1 FROM exemptions e WHERE e.outlet=page.id AND e.owner=owner_id.owner AND e.month=report_month AND e.status='approved') exempt,
      (SELECT json_object('id',r.id,'status',CASE WHEN COALESCE(json_extract(r.data,'$.revoked'),0) THEN 'revoked' ELSE r.status END)
       FROM reports r WHERE r.outlet=page.id AND r.owner=owner_id.owner AND r.month=report_month ORDER BY r.version DESC LIMIT 1) latest_report,
      EXISTS (SELECT 1 FROM reports r JOIN settlements s ON s.month=r.month AND s.status='approved'
       WHERE r.outlet=page.id AND r.owner=owner_id.owner AND r.month=report_month AND r.current=1 AND r.status='approved'
       AND NOT COALESCE(json_extract(r.data,'$.revoked'),0)
       AND EXISTS (SELECT 1 FROM json_each(s.data,'$.reportIds') ref WHERE ref.value=r.id)) settled,
      (SELECT v.status FROM verifications v WHERE v.outlet=page.id AND v.owner=owner_id.owner AND v.month=current_month
       ORDER BY v.rowid DESC LIMIT 1) location_status,
      (SELECT b.status FROM bills b WHERE b.outlet=page.id AND b.owner=owner_id.owner AND b.month=current_month
       ORDER BY CASE WHEN b.status='reversed' THEN 1 ELSE 0 END,b.rowid DESC LIMIT 1) fee_status
    FROM page CROSS JOIN parameters owner_id
  `).all(JSON.stringify(outlets.map(outlet => outlet.id)), owner, reportMonth, period);

  const byId = new Map(rows.map(row => [row.id, row]));
  for (const outlet of outlets) {
    const row = byId.get(outlet.id);
    const exemptions = row.exempt ? [{ outlet: outlet.id, month: reportMonth, status: 'approved' }] : [];
    const reason = reportMonthStatus({ today, exemptions }, outlet, reportMonth);
    const latestReport = row.latest_report ? JSON.parse(row.latest_report) : null;
    const reportStatus = reason === 'exempt' ? 'exempt'
      : latestReport?.status || ({ full_pause: 'exemption_pending', no_operation: 'not_required' })[reason] || 'missing';
    const settlementStatus = ['exempt', 'not_required'].includes(reportStatus) ? 'not_applicable' : row.settled ? 'settled' : 'unsettled';
    const needsLocation = ['open', 'paused'].includes(outlet.status);
    outlet.summary = {
      period,
      report: { month: reportMonth, status: reportStatus, settlementStatus,
        ...(reportStatus === 'returned' ? { returnedVersionId: latestReport.id } : {}) },
      location: { month: period, status: row.location_status || (needsLocation ? 'missing' : 'not_required') },
      fee: { month: period, status: row.fee_status || 'missing' },
    };
  }
}

module.exports = { addOutletSummaries };
