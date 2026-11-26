'use strict';

function activatedStaffIds(db, staffIds) {
  if (!staffIds.length) return [];
  return db.prepare('SELECT actor FROM credentials WHERE actor IN (SELECT value FROM json_each(?))')
    .all(JSON.stringify(staffIds)).map(row => row.actor);
}

module.exports = { activatedStaffIds };
