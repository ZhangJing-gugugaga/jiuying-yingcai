'use strict';

function qualifiedOutletLabels(db, owner, outletIds) {
  const ids = new Set(outletIds.filter(Boolean));
  if (!ids.size) return new Map();

  const outlets = db.prepare(`WITH selected_names AS (
    SELECT DISTINCT json_extract(data,'$.name') AS name
    FROM outlets WHERE owner=? AND id IN (SELECT value FROM json_each(?))
  )
  SELECT id,json_extract(data,'$.name') AS name,json_extract(data,'$.city') AS city,
    json_extract(data,'$.province') AS province,json_extract(data,'$.district') AS district
  FROM outlets WHERE owner=? AND json_extract(data,'$.name') IN (SELECT name FROM selected_names)`
  ).all(owner, JSON.stringify([...ids]), owner);

  const names = Map.groupBy(outlets, outlet => outlet.name);
  const labels = new Map();
  for (const [name, group] of names) {
    if (group.length < 2) continue;
    const byArea = Map.groupBy(group, outlet =>
      [...new Set([outlet.city || outlet.province, outlet.district].filter(Boolean))].join(' '));
    for (const [area, peers] of byArea) {
      for (const { id } of peers) {
        if (ids.has(id)) labels.set(id, [name, area, ...(!area || peers.length > 1 ? [id] : [])].filter(Boolean).join(' · '));
      }
    }
  }
  return labels;
}

module.exports = { qualifiedOutletLabels };
