'use strict';
// Saugroboter in Apple Home (Wunsch Thomas 13.10.2026). Apple Home zeigt Saugroboter nur als eigenständiges Matter-Gerät,
// nicht hinter einer Bridge (Erfahrung anderer Matter-Bridges) – deshalb ein eigener Matter-Knoten „Saugroboter“
// (Port 5541, eigener Kopplungscode). Er läuft unabhängig von der Bridge weiter, auch wenn die Bridge neu startet
// (die Apple-Home-Kopplung der Bridge bleibt unberührt). Einschalten auf der Saugroboter-Seite.
// Abbildung:
//   Betriebsart (RvcRunMode): Bereit / Reinigen – „Reinigen“ mit ausgewählten Räumen (ServiceArea) = Raumreinigung
//   Reinigungsmodus (RvcCleanMode): Saugstärke Leise / Normal / Max / Max+
//   Zustand (RvcOperationalState): reinigt, pausiert, fährt zur Station, lädt, in der Station, Störung (Staubbeutel voll …)
//   Befehle Pause, Weiter, Zur Station; Akku (PowerSource)
const os = require('node:os');
const PORT = 5541;
const INVALID = new Set([0, 11111111, 22222222, 33333333, 44444444, 55555555, 66666666, 77777777, 88888888, 99999999, 12345678, 87654321]);
// Matter-Kennzahlen (Spezifikation 1.4): RvcRunMode/RvcCleanMode-ModeTags, OperationalState-/ErrorState-IDs
const TAG = Object.freeze({ auto: 0, quiet: 2, max: 7, deepClean: 16384, vacuum: 16385, mop: 16386, idle: 16384, cleaning: 16385 });
const OP = Object.freeze({ stopped: 0, running: 1, paused: 2, error: 3, seekingCharger: 64, charging: 65, docked: 66 });
const ERR = Object.freeze({ none: 0, unableToStart: 1, unableToComplete: 2, invalidInState: 3, dockNotFound: 64, stuck: 65, dustBinMissing: 66, dustBinFull: 67, waterEmpty: 68, waterMissing: 69, lidOpen: 70, mopMissing: 71 });
const ERROR_MAP = Object.freeze({ 312: ERR.dustBinFull, 311: ERR.dustBinFull, 114: ERR.dustBinFull, 110: ERR.dustBinMissing, 301: ERR.waterEmpty, 322: ERR.waterEmpty, 303: ERR.waterMissing, 126: ERR.waterMissing, 302: ERR.dustBinFull, 305: ERR.dustBinFull, 318: ERR.dustBinFull, 310: ERR.lidOpen, 102: ERR.stuck, 103: ERR.stuck, 105: ERR.stuck, 128: ERR.mopMissing, 1027: ERR.dockNotFound });
const RUN_MODES = Object.freeze([{ label: 'Bereit', mode: 1, modeTags: [{ value: TAG.idle }] }, { label: 'Reinigen', mode: 2, modeTags: [{ value: TAG.cleaning }] }]);
const CLEAN_MODES = Object.freeze([
  { label: 'Leise', mode: 1, modeTags: [{ value: TAG.vacuum }, { value: TAG.quiet }], speed: 1000 },
  { label: 'Normal', mode: 2, modeTags: [{ value: TAG.vacuum }, { value: TAG.auto }], speed: 0 },
  { label: 'Max', mode: 3, modeTags: [{ value: TAG.vacuum }, { value: TAG.max }], speed: 1 },
  { label: 'Max+', mode: 4, modeTags: [{ value: TAG.vacuum }, { value: TAG.deepClean }], speed: 2 }
]);
const fail = (m, s = 400) => Object.assign(Error(m), { status: s });
const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
const ok = () => ({ commandResponseState: { errorStateId: ERR.none } });
const bad = (id = ERR.unableToStart, text = '') => ({ commandResponseState: { errorStateId: id, errorStateDetails: text.slice(0, 64) } });

let refs = null, node = null, endpoint = null, svc = null, configPath = null, starting = null, lastError = null, lastState = null, listener = null;

function settings(path) { try { const c = JSON.parse(require('node:fs').readFileSync(path, 'utf8')).ecovacs; return isObject(c) ? c : {}; } catch { return {}; } }
function randomPairing() { let p; do p = require('node:crypto').randomInt(1, 99999999); while (INVALID.has(p)); return { passcode: p, discriminator: require('node:crypto').randomInt(0, 4096) }; }

// Zustand des Dienstes → Matter-Werte
function values(s) {
  const st = s.status || {}, errs = [...(st.errors || []), ...(st.stationErrors || [])];
  const mapped = errs.map(c => ERROR_MAP[c]).find(Boolean);
  let op = { cleaning: OP.running, paused: OP.paused, returning: OP.seekingCharger, docked: st.battery >= 100 ? OP.docked : OP.charging, idle: st.charging ? OP.charging : OP.stopped, error: OP.error }[st.state] ?? OP.stopped;
  let error = ERR.none, details = '';
  if (st.state === 'error' || (mapped && !['cleaning', 'returning'].includes(st.state))) { op = OP.error; error = mapped || ERR.unableToComplete; details = errs.length ? require('./ecovacs').errorText(errs[0]) : 'Störung'; }
  const run = ['cleaning', 'paused', 'returning'].includes(st.state) ? 2 : 1;
  const clean = CLEAN_MODES.find(m => m.speed === s.settings?.speed)?.mode ?? 2;
  const battery = Number.isFinite(st.battery) ? Math.max(0, Math.min(100, st.battery)) : null;
  return { op, error, details, run, clean, battery, charging: !!st.charging };
}
const mapName = s => String(s.map?.name || 'Wohnung').slice(0, 64) || 'Wohnung';
function areas(s) {
  const list = s.roomList(), seen = new Set();
  return list.slice(0, 32).map(r => { let name = String(r.name).slice(0, 128); if (seen.has(name)) name = (name + ' ' + r.id).slice(0, 128); seen.add(name); return { areaId: r.id, mapId: 1, areaInfo: { locationInfo: { locationName: name, floorNumber: null, areaType: null }, landmarkInfo: null } }; });
}

function buildEndpoint() {
  const { main, behaviors, devices } = refs;
  const OpBase = (devices.RoboticVacuumCleanerRequirements?.RvcOperationalStateServer || behaviors.RvcOperationalStateServer).enable({ commands: { goHome: true } });
  const act = async (action, opts) => { try { await svc.control(action, { ...opts, by: 'Apple Home' }); return true; } catch (e) { lastError = e.message; return false; } };
  class Op extends OpBase {
    async pause() { return (await act('pause')) ? ok() : bad(ERR.invalidInState, lastError || ''); }
    async resume() { return (await act('resume')) ? ok() : bad(ERR.unableToStart, lastError || ''); }
    async goHome() { return (await act('home')) ? ok() : bad(ERR.unableToComplete, lastError || ''); }
  }
  class Run extends behaviors.RvcRunModeServer {
    async changeToMode({ newMode }) {
      if (!RUN_MODES.some(m => m.mode === newMode)) return { status: 1, statusText: 'Unbekannte Betriebsart' };
      if (newMode === this.state.currentMode) return { status: 0, statusText: '' };
      let done;
      if (newMode === 2) { const sel = this.endpoint.state.serviceArea?.selectedAreas || []; done = await act(sel.length ? 'rooms' : 'start', sel.length ? { rooms: [...sel] } : {}); }
      else done = await act('stop');
      if (!done) return { status: 2, statusText: (lastError || 'Saugroboter hat abgelehnt').slice(0, 64) };
      return { status: 0, statusText: '' }; // Anzeige folgt der Rückmeldung des Roboters (sync)
    }
  }
  class Clean extends behaviors.RvcCleanModeServer {
    async changeToMode({ newMode }) {
      const m = CLEAN_MODES.find(x => x.mode === newMode); if (!m) return { status: 1, statusText: 'Unbekannter Modus' };
      try { await svc.setSetting('speed', m.speed); } catch (e) { return { status: 2, statusText: String(e.message).slice(0, 64) }; }
      return { status: 0, statusText: '' }; // setSetting liest zurück und meldet „change“ → sync
    }
  }
  const Power = behaviors.PowerSourceServer.with('Battery', 'Rechargeable');
  // Räume mit Karte (Feature „Maps“): matter.js 0.16.11 bricht ohne Karte beim Start ab (supportedMaps fehlt)
  const Areas = behaviors.ServiceAreaServer.with('Maps');
  const type = devices.RoboticVacuumCleanerDevice.with(Op, Run, Clean, Areas, Power);
  const v = values(svc), name = (svc.robot?.name || 'Saugroboter').slice(0, 32);
  return new main.Endpoint(type, {
    id: 'saugroboter',
    rvcRunMode: { supportedModes: RUN_MODES, currentMode: v.run },
    rvcCleanMode: { supportedModes: CLEAN_MODES.map(({ speed, ...m }) => m), currentMode: v.clean },
    rvcOperationalState: { operationalStateList: Object.values(OP).map(id => ({ operationalStateId: id })), operationalState: v.op, operationalError: { errorStateId: v.error, errorStateDetails: v.details || undefined }, phaseList: null, currentPhase: null },
    serviceArea: { supportedAreas: areas(svc), selectedAreas: [], currentArea: null, supportedMaps: [{ mapId: 1, name: mapName(svc) }] },
    powerSource: { status: 1, order: 0, description: name + ' Akku', endpointList: [], batChargeLevel: 0, batReplaceability: 0, batReplacementNeeded: false, batPresent: true, batPercentRemaining: v.battery === null ? null : v.battery * 2, batChargeState: v.charging ? 1 : 3, batFunctionalWhileCharging: false }
  });
}

async function sync() {
  if (!endpoint || !svc) return;
  const v = values(svc), s = endpoint.state;
  const up = {};
  if (s.rvcOperationalState.operationalState !== v.op || s.rvcOperationalState.operationalError.errorStateId !== v.error) up.rvcOperationalState = { operationalState: v.op, operationalError: { errorStateId: v.error, errorStateDetails: v.details || undefined } };
  if (s.rvcRunMode.currentMode !== v.run) up.rvcRunMode = { currentMode: v.run };
  if (s.rvcCleanMode.currentMode !== v.clean) up.rvcCleanMode = { currentMode: v.clean };
  const a = areas(svc); if (JSON.stringify(a) !== JSON.stringify(s.serviceArea.supportedAreas)) up.serviceArea = { supportedAreas: a, selectedAreas: s.serviceArea.selectedAreas.filter(id => a.some(x => x.areaId === id)) };
  const bat = v.battery === null ? null : v.battery * 2;
  if (s.powerSource.batPercentRemaining !== bat || s.powerSource.batChargeState !== (v.charging ? 1 : 3)) up.powerSource = { batPercentRemaining: bat, batChargeState: v.charging ? (v.battery >= 100 ? 2 : 1) : 3, batChargeLevel: v.battery !== null && v.battery < 15 ? 1 : 0 };
  if (Object.keys(up).length) await endpoint.set(up);
  // Reinigung beendet (vorher reinigen/zurückfahren, jetzt Station) → Ereignis „Vorgang abgeschlossen“ für Apple-Home-Mitteilungen
  if (lastState && ['cleaning', 'returning'].includes(lastState) && ['docked', 'idle'].includes(svc.status.state)) {
    try { await endpoint.act(agent => agent.rvcOperationalState.events.operationCompletion.emit({ completionErrorCode: ERR.none, totalOperationalTime: null, pausedTime: null }, agent.context)); } catch {}
  }
  lastState = svc.status.state;
}

function listen() { const on = (ip6 = false) => (os.networkInterfaces().eth0 || []).find(i => !i.internal && (ip6 ? i.family === 'IPv6' : i.family === 'IPv4')); const v4 = on(), v6 = (os.networkInterfaces().eth0 || []).find(i => i.family === 'IPv6' && i.address.startsWith('fe80:')) || on(true); return v6 ? { port: PORT, ipv4: !!v4, listeningAddressIpv4: v4?.address, listeningAddressIpv6: v6.address.includes('%') ? v6.address : v6.address.startsWith('fe80:') ? v6.address + '%eth0' : v6.address } : { port: PORT }; }

async function start() {
  if (node || starting || !refs || !configPath) return starting;
  starting = (async () => {
    const cfg = settings(configPath), pairing = cfg.matterPairing;
    if (!isObject(pairing) || !Number.isInteger(pairing.passcode) || INVALID.has(pairing.passcode) || !Number.isInteger(pairing.discriminator)) throw Error('Kopplungsdaten fehlen');
    svc = require('./ecovacs').source(configPath);
    const { main, types, bridgeConfig } = refs;
    const n = await main.ServerNode.create({
      id: 'ecovacs-saugroboter', network: listen(),
      commissioning: { passcode: pairing.passcode, discriminator: pairing.discriminator },
      productDescription: { name: 'Saugroboter', vendorId: types.VendorId(bridgeConfig.vendorId), productId: bridgeConfig.productId + 1 },
      basicInformation: { vendorName: 'Ecovacs über CCU3', vendorId: types.VendorId(bridgeConfig.vendorId), productName: (svc.robot?.model || 'DEEBOT').slice(0, 32), productId: bridgeConfig.productId + 1, nodeLabel: (svc.robot?.name || 'Saugroboter').slice(0, 32), serialNumber: 'MHB-RVC-0001', hardwareVersion: 1, hardwareVersionString: '1.0', softwareVersion: 1, softwareVersionString: '1.0.0' }
    });
    endpoint = buildEndpoint(); await n.add(endpoint);
    node = n; listener = () => sync().catch(() => {}); svc.on('change', listener);
    await n.start(); console.log('[ecovacs-matter] Saugroboter-Knoten läuft (Port ' + PORT + ')');
  })().catch(e => { console.error('[ecovacs-matter] Start fehlgeschlagen: ' + (e.message || e) + (process.env.ECOVACS_DEBUG ? require('node:util').inspect(e, { depth: 6 }) : '')); lastError = e.message; node = null; endpoint = null; }).finally(() => { starting = null; });
  return starting;
}
async function stopNode() {
  if (svc && listener) svc.off('change', listener); listener = null;
  const n = node; node = null; endpoint = null;
  if (n) try { await n.close(); } catch {}
}
// Aus der Bridge (index.js) bei jedem Bridge-Start: Matter-Bausteine merken; Knoten nur einmal anlegen (überlebt Bridge-Neustarts)
function attach(bridge, matterRefs) {
  try {
    if (typeof matterRefs?.configPath !== 'string' || !matterRefs.configPath) return;
    configPath = matterRefs.configPath;
    refs = { ...matterRefs, bridgeConfig: { vendorId: bridge.config.bridge.vendorId, productId: bridge.config.bridge.productId } };
    // erst nach dem Start der Bridge (sie kündigt sich zuerst an); danach läuft der Knoten unabhängig weiter
    if (settings(configPath).matter === true && !node && !starting) { const t = setTimeout(() => start(), matterRefs.delayMs ?? 20000); t.unref?.(); }
  } catch (e) { console.error('[ecovacs-matter] ' + (e.message || e)); }
}
function info(web) {
  const cfg = settings(web.deps.configPath), c = node?.state?.commissioning, codes = c?.pairingCodes;
  // CCU-Firewall „eingeschränkt“ ohne Port 5541: Apple Home erreicht den Saugroboter nicht – Hinweis auf der Seite (freigeben tut Thomas selbst)
  let firewallBlocked = null; try { const p = { conf: '/etc/config/firewall.conf', ...(web.deps?.firewallPaths || {}) }, f = require('./ccu-firewall')._test.parse(require('node:fs').readFileSync(p.conf, 'latin1')); firewallBlocked = f.mode === 'RESTRICTIVE' && !f.userPorts.includes(PORT); } catch {}
  return { enabled: cfg.matter === true, running: !!node && !!endpoint, starting: !!starting, port: PORT, firewallBlocked, commissioned: !!c?.commissioned, qrPairingCode: !c?.commissioned ? codes?.qrPairingCode || null : null, manualPairingCode: !c?.commissioned ? codes?.manualPairingCode || null : null, error: node ? null : lastError, available: !!refs };
}
async function setEnabled(web, enabled) {
  if (enabled && !require('./ecovacs').ensure(web).connected) throw fail('Zuerst den Saugroboter verbinden', 409);
  if (enabled && !refs) throw fail('Matter-Bridge startet noch – bitte gleich noch einmal', 409);
  web.writeConfigPatch(c => { c.ecovacs = isObject(c.ecovacs) ? { ...c.ecovacs } : {}; c.ecovacs.matter = enabled; if (enabled && !isObject(c.ecovacs.matterPairing)) c.ecovacs.matterPairing = randomPairing(); });
  configPath = web.deps.configPath;
  if (enabled) await start(); else await stopNode();
  return { success: true, ...info(web) };
}
module.exports = { attach, info, setEnabled, values, areas, RUN_MODES, CLEAN_MODES, OP, ERR, _test: { stopNode, start, sync, set svc(v) { svc = v; }, get endpoint() { return endpoint; }, get node() { return node; } } };
