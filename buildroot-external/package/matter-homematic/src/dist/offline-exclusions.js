'use strict';
// Suppress warnings, never falsify the measured device state.
const eligible = row => /^(smartplus|smartlife|dyson|cux):/.test(row.id);
function ignored(web, id) {
  return web.security.configSnapshot.read().offlineWarningExclusions?.[id] === true;
}
function decorate(web, rows) {
  return rows.map(row => ({...row, canIgnoreWarning:eligible(row), warningIgnored:eligible(row) && ignored(web,row.id)}));
}
function save(web, monitor, input) {
  if (!input || Object.keys(input).length !== 2 || typeof input.id !== 'string' || typeof input.ignored !== 'boolean' ||
      !Object.hasOwn(input,'id') || !Object.hasOwn(input,'ignored') || !monitor.rows.some(row => row.id === input.id && eligible(row))) {
    throw Object.assign(Error('Ein vorhandenes Integrations- oder CUxD-Gerät auswählen'),{status:400});
  }
  web.writeConfigPatch(config => {
    const entries = Object.assign(Object.create(null),config.offlineWarningExclusions);
    if(input.ignored) entries[input.id]=true; else delete entries[input.id];
    config.offlineWarningExclusions=entries;
  });
  monitor.generation++;
  monitor.incidents.delete(input.id);
}
module.exports={eligible,ignored,decorate,save};
