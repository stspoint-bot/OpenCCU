'use strict';
// Alte Adressen der früheren Startseite (/index.html#devices usw.) auf die neuen Seiten umleiten,
// damit Lesezeichen und Verweise weiter funktionieren.
(function () {
  const target = { '#devices': '/geraete.html', '#rooms': '/raeume.html', '#sysvars': '/index.html' }[location.hash];
  let legacy = false; try { legacy = sessionStorage.getItem('mh-open-devices') === 'true'; if (legacy) sessionStorage.removeItem('mh-open-devices'); } catch {}
  if (target) location.replace(target); else if (legacy) location.replace('/geraete.html');
})();
