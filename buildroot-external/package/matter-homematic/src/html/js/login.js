'use strict';
async function loginResponse(res) {
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); }
  catch {
    throw new Error(`Anmelde-API nicht erreichbar (HTTP ${res.status}). Add-on-Dienst nach dem Update neu starten und prüfen, dass der HTTPS-Proxy auch /api/ an Matter-Homematic weiterleitet. Aktuelle Adresse: ${location.origin}`);
  }
  if (!res.ok) throw new Error(data.error || `Anmelde-API: HTTP ${res.status}`);
  return data;
}
// „Dieses Gerät merken“ nur über HTTPS anbieten (der Server merkt ohne HTTPS ohnehin nichts)
if (location.protocol === 'https:') { const z = document.getElementById('merken-zeile'); if (z) z.hidden = false; }
document.getElementById('login').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.target; const button = form.querySelector('button'); button.disabled = true;
  const error = document.getElementById('error'); error.textContent = '';
  try {
    // Check the backend before sending any credentials. A new static page can
    // otherwise coexist with a still-running old service or a wrong proxy route.
    const info = await loginResponse(await fetch('/api/?method=webAuthInfo', { cache: 'no-store' }));
    if (info.protocol !== 'mh-web-auth-v1') throw new Error('Dieser Webdienst unterstützt die neue Anmeldung nicht. Add-on-Dienst neu starten und Proxy-Ziel prüfen.');
    const adminLogin = new URLSearchParams(location.search).get('admin') === '1';
    if (info.authRequired === false && !adminLogin) { location.replace('/'); return; }
    await loginResponse(await fetch('/api/?method=webLogin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: form.username.value, password: form.password.value, ...(form.merken && form.merken.checked ? { merken: true } : {}) }) }));
    // Fixed local destination: never accept arbitrary redirect URLs from query input.
    // Handy (Wunsch Thomas): direkt auf die Handy-Seite
    location.replace((/iPhone|iPod|Android.+Mobile|Windows Phone/i.test(navigator.userAgent) || (window.matchMedia && matchMedia('(max-width: 600px)').matches)) ? '/mobil.html' : adminLogin ? '/backup-storage.html' : '/');
  } catch (err) { error.textContent = err.message; }
  finally { form.password.value = ''; button.disabled = false; }
});
