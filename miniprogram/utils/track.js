/* DEV_ONLY_START */
const config = require('../config');
const events = new Set(['open_home', 'task_click', 'report_submit', 'bill_pay', 'location_submit', 'ticket_submit']);
const outcomes = new Set(['opened', 'submitted', 'started']);
const commandEvents = {
  'report.submit': 'report_submit',
  'location.submit': 'location_submit',
  'support.ticket': 'ticket_submit',
};
/* DEV_ONLY_END */

function track(event, outcome) {
  /* DEV_ONLY_START */
  if (config.development && events.has(event) && outcomes.has(outcome)) {
    console.info('[九盈业务验证]', { event, outcome });
  }
  /* DEV_ONLY_END */
}

function trackCommand(command, result) {
  /* DEV_ONLY_START */
  if (result?.result && !result.replayed) track(commandEvents[command], 'submitted');
  /* DEV_ONLY_END */
}

module.exports = { track, trackCommand };
