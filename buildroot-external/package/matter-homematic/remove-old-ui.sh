#!/bin/sh
# CCU3-neu: Reste der alten OpenCCU-Weboberflaeche aus dem Systemabbild entfernen (Matter-Oberflaeche ersetzt sie).
# Aufruf aus dem Buildroot-Finalize-Hook: remove-old-ui.sh <TARGET_DIR> <Fehlerseite.html>
# Es werden nur Dateien geloescht, die auf der laufenden CCU seit dem 11.10.2026 per lighttpd gesperrt (403) sind.
set -e
T="$1"
ERRPAGE="$2"
W="${T}/www"
# Der Finalize-Hook laeuft auch im verschachtelten 32-Bit-Bau (multilib32) ohne /www: dort nichts tun.
[ -d "$W" ] || { echo "remove-old-ui: ${W} fehlt (Nebenbau multilib32) - uebersprungen"; exit 0; }

rmf() { for p in "$@"; do rm -rf "${W}/${p}"; done; }

# Einstellungs-/Konfigurationsseiten (CGI) der alten Oberflaeche. cp_security.cgi und control_panel.cgi bleiben (gekuerzt, Patch 0300).
rmf config/help.cgi config/cp_add_device.cgi config/cp_time.cgi config/cp_network.cgi config/cp_software.cgi \
    config/cp_advancedsettings.cgi config/cp_maintenance.cgi config/cp_display.cgi \
    config/ic_deviceFirmwareOverview.cgi config/ic_deviceparameters.cgi config/ic_seldevice.cgi config/ic_neweasymode.cgi \
    config/ic_ifacecmd.cgi config/ic_md.cgi config/ic_linkpeerlist.cgi config/ic_selchannel.cgi config/ic_setprofiles.cgi \
    config/easymodes

# Seiten der alten Oberflaeche (ReGa-Vorlagen): Startseite, Gaeste, Bedienen, Favoriten, Raeume, Gewerke, Programme,
# Systemvariablen, Benutzer, Direktverknuepfungen, neue Geraete, Programmauswahl
rmf rega/pages/tabs/startpage.htm rega/pages/tabs/guest rega/pages/tabs/control.htm rega/pages/tabs/control \
    rega/pages/tabs/favorites.htm rega/pages/tabs/favViewer.htm \
    rega/pages/tabs/user/favOverview.htm rega/pages/tabs/user/newFav.htm rega/pages/tabs/user/userAdministrationUser.htm \
    rega/pages/tabs/admin/linkprog.htm rega/pages/tabs/admin/systemvars.htm rega/pages/tabs/admin/userAdministration.htm \
    rega/pages/tabs/admin/views/programs.htm rega/pages/tabs/admin/views/programlist.htm \
    rega/pages/tabs/admin/views/functions.htm rega/pages/tabs/admin/views/functionchannels.htm \
    rega/pages/tabs/admin/views/rooms.htm rega/pages/tabs/admin/views/roomchannels.htm \
    rega/pages/tabs/admin/views/newdevices.htm rega/pages/tabs/admin/views/newdevicechannels.htm \
    rega/pages/tabs/admin/views/newDeviceLoader.htm rega/pages/tabs/admin/views/newdevicechannelsloader.htm \
    rega/pages/msg/programChooser.htm rega/esp/favorites.htm

# Rest der alten Oberflaeche (13.10.2026, live getestet: /www per Bind-Mount ohne diese Teile, 56 -> 16 MB; Bridge, JSON-RPC, ReGa unveraendert):
# alte WebUI (webui, pda), ise-Oberflaeche, ReGa-Seitenvorlagen, uebrige Konfig-Dialoge/Hilfsdateien. Bleiben: api, tcl, tools, upnp, addons,
# config/devdescr + config/img/devices (Geraetebilder fuer die Matter-Oberflaeche), control_panel.cgi, cp_security.cgi, backup.tcl, stringtable.
rmf webui pda ise/htm ise/js ise/img rega/pages
rmf config/cp_add_device.cgi config/cp_advancedsettings.cgi config/cp_display.cgi config/cp_maintenance.cgi config/cp_network.cgi \
    config/cp_software.cgi config/cp_time.cgi config/help.cgi config/st_values.cgi config/st_values.js config/display \
    config/virtualHelp.tcl config/fileupload.ccc config/easymodes
for f in "${W}"/config/ic_*.cgi "${W}"/config/ic_*.tcl; do rm -f "$f"; done
if [ -d "${W}/config/img" ]; then
  for d in "${W}"/config/img/*; do [ "$(basename "$d")" = devices ] || rm -rf "$d"; done
fi

# Fehlerseiten: statt der alten WebUI-Seiten (mit Uebersetzungsschluesseln) die eigene "startet neu"-Seite
if [ -f "$ERRPAGE" ]; then
  mkdir -p "${W}/error"
  for c in 500 502 503 504; do cp -f "$ERRPAGE" "${W}/error/error-${c}.html"; chmod 0644 "${W}/error/error-${c}.html"; done
fi
echo "remove-old-ui: fertig"
